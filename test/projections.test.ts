import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConcurrencyError,
  createStore,
  type FoldFn,
  type Store,
  type StoredEvent,
} from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "./helpers/test-db.js";

interface OrderPlaced {
  orderId: string;
  amount: number;
  region: string;
}

interface NoteAdded {
  text: string;
}

interface OrderState {
  orderId: string;
  total: number;
  notes: readonly string[];
}

interface OrderRegions {
  regions: readonly string[];
}

interface AuditLogged {
  text: string;
}

function schema<TOutput extends object>(
  name: string,
  check: (value: unknown) => boolean,
): StandardSchemaV1<unknown, TOutput> & { readonly name: string } {
  return {
    name,
    "~standard": {
      version: 1,
      vendor: "test",
      types: { input: {} as TOutput, output: {} as TOutput },
      validate: (value: unknown) =>
        check(value)
          ? { value: value as TOutput }
          : { issues: [{ message: `${name}: invalid payload` }] },
    },
  };
}

const orderPlacedSchema = schema<OrderPlaced>("order_placed", (value) => {
  const event = value as Partial<OrderPlaced> | null;
  return (
    typeof event?.orderId === "string" &&
    typeof event?.amount === "number" &&
    typeof event?.region === "string"
  );
});

const noteAddedSchema = schema<NoteAdded>("note_added", (value) => {
  const event = value as Partial<NoteAdded> | null;
  return typeof event?.text === "string";
});

const orderStateSchema = schema<OrderState>("order_state", (value) => {
  const state = value as Partial<OrderState> | null;
  return (
    typeof state?.orderId === "string" &&
    typeof state?.total === "number" &&
    Array.isArray(state?.notes)
  );
});

const orderRegionsSchema = schema<OrderRegions>("order_regions", (value) => {
  const state = value as Partial<OrderRegions> | null;
  return Array.isArray(state?.regions);
});

const auditLoggedSchema = schema<AuditLogged>("audit_logged", (value) => {
  const event = value as Partial<AuditLogged> | null;
  return typeof event?.text === "string";
});

const foldOrderState: FoldFn = (state, event) => {
  const current = (state ?? { orderId: "", total: 0, notes: [] }) as OrderState;
  const stored = event as StoredEvent;
  switch (stored.type) {
    case "order_placed": {
      const placed = stored.data as OrderPlaced;
      return { ...current, orderId: placed.orderId, total: current.total + placed.amount };
    }
    case "note_added":
      return { ...current, notes: [...current.notes, (stored.data as NoteAdded).text] };
    default:
      return current;
  }
};

const foldOrderRegions: FoldFn = (state, event) => {
  const stored = event as StoredEvent;
  const regions = (state as OrderRegions | undefined)?.regions ?? [];
  if (stored.type === "order_placed") {
    return { regions: [...regions, (stored.data as OrderPlaced).region] };
  }
  return { regions };
};

let db: TestDatabase;
let store: Store;

beforeAll(async () => {
  db = await createTestDatabase({ onnotice: () => {} });
  store = createStore({ sql: db.sql });
  store.event("order_placed", orderPlacedSchema);
  store.event("note_added", noteAddedSchema);
  // No stream registration admits audit_logged, so appending it leaves the stream ungoverned.
  store.event("audit_logged", auditLoggedSchema);
  store.upcaster("order_placed", (old) => ({ ...(old as object), region: "eu" }));
  store.stream("order", { events: ["order_placed", "note_added"] });
  store.aggregate("order", orderStateSchema, foldOrderState, { inline: true });
  store.aggregate("order", orderRegionsSchema, foldOrderRegions);
  await store.migrate();
});

afterAll(async () => {
  await db.teardown();
});

describe("inline projection registration", () => {
  it("creates a snapshot table for an inline aggregate at migrate", async () => {
    const tables = await db.sql`
      select tablename from pg_tables
      where schemaname = 'public' and tablename = 'magpie_doc_order_state'
    `;
    expect(tables.length).toBe(1);
  });

  it("creates no table for a live-only aggregate", async () => {
    const tables = await db.sql`
      select tablename from pg_tables
      where schemaname = 'public' and tablename = 'magpie_doc_order_regions'
    `;
    expect(tables.length).toBe(0);
  });
});

async function snapshotRow(
  streamId: string,
): Promise<{ data: unknown; version: string } | undefined> {
  const rows = await db.sql`
    select data, version from public.magpie_doc_order_state where id = ${streamId}
  `;
  return rows[0] as { data: unknown; version: string } | undefined;
}

describe("inline projection application", () => {
  it("persists the fold output on append with the stream's version", async () => {
    await store.session(async (s) => {
      await s.events.append("p1", [
        { type: "order_placed", data: { orderId: "p1", amount: 5, region: "eu" } },
        { type: "note_added", data: { text: "hello" } },
      ]);
    });
    await store.session(async (s) => {
      await s.events.append("p1", [
        { type: "order_placed", data: { orderId: "p1", amount: 7, region: "us" } },
      ]);
    });

    const row = await snapshotRow("p1");
    expect(row?.data).toEqual({ orderId: "p1", total: 12, notes: ["hello"] });
    expect(row?.version).toBe("3");
  });

  it("projects once per stream at commit, folding every event in the session", async () => {
    await store.session(async (s) => {
      await s.events.append("p4", [
        { type: "order_placed", data: { orderId: "p4", amount: 1, region: "eu" } },
      ]);
      await s.events.append("p4", [
        { type: "order_placed", data: { orderId: "p4", amount: 2, region: "eu" } },
      ]);
    });

    const row = await snapshotRow("p4");
    expect(row?.data).toEqual({ orderId: "p4", total: 3, notes: [] });
    expect(row?.version).toBe("2");
  });

  it("rebuilds a deleted snapshot row from the full history on the next append", async () => {
    await store.session(async (s) => {
      await s.events.append("p3", [
        { type: "order_placed", data: { orderId: "p3", amount: 4, region: "eu" } },
      ]);
    });
    await db.sql`delete from public.magpie_doc_order_state where id = 'p3'`;
    await store.session(async (s) => {
      await s.events.append("p3", [{ type: "note_added", data: { text: "back" } }]);
    });

    const row = await snapshotRow("p3");
    expect(row?.data).toEqual({ orderId: "p3", total: 4, notes: ["back"] });
    expect(row?.version).toBe("2");
  });

  it("feeds upcast events to the fold in inline updates", async () => {
    await db.sql`
      insert into public.magpie_streams (id, version, type) values ('p2', 1, 'order')
    `;
    await db.sql`
      insert into public.magpie_events (stream_id, version, type, data)
      values ('p2', 1, 'order_placed', ${db.sql.json({ orderId: "p2", amount: 5 })})
    `;
    await store.session(async (s) => {
      await s.events.append("p2", [
        { type: "order_placed", data: { orderId: "p2", amount: 9, region: "ap" } },
      ]);
    });

    const row = await snapshotRow("p2");
    expect(row?.data).toEqual({ orderId: "p2", total: 14, notes: [] });
  });

  it("keeps the live lifecycle available on the same definition", async () => {
    const state = await store.fold(orderStateSchema, "p1");
    expect(state).toEqual({ orderId: "p1", total: 12, notes: ["hello"] });
  });

  it("leaves ungoverned streams without snapshots", async () => {
    await store.session(async (s) => {
      await s.events.append("p5", [{ type: "audit_logged", data: { text: "logged" } }]);
    });

    const row = await snapshotRow("p5");
    expect(row).toBeUndefined();
  });
});

describe("inline projection consistency", () => {
  it("leaves the projection unchanged when an append hits a concurrency conflict", async () => {
    await store.session(async (s) => {
      await s.events.append("c1", [
        { type: "order_placed", data: { orderId: "c1", amount: 3, region: "eu" } },
      ]);
    });
    const before = await snapshotRow("c1");

    await expect(
      store.session(async (s) => {
        await s.events.append(
          "c1",
          [{ type: "order_placed", data: { orderId: "c1", amount: 9, region: "eu" } }],
          { expectedVersion: 99n },
        );
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);

    expect(await snapshotRow("c1")).toEqual(before);
  });

  it("leaves the projection unchanged when an append fails validation", async () => {
    await expect(
      store.session(async (s) => {
        await s.events.append("c2", [{ type: "order_placed", data: { nope: true } }]);
      }),
    ).rejects.toMatchObject({ name: "ValidationError" });

    expect(await snapshotRow("c2")).toBeUndefined();
  });

  it("projects appends made in a nested session", async () => {
    await store.session(async (s) => {
      await s.session(async (sp) => {
        await sp.events.append("p7", [
          { type: "order_placed", data: { orderId: "p7", amount: 2, region: "eu" } },
        ]);
      });
    });

    const row = await snapshotRow("p7");
    expect(row?.data).toEqual({ orderId: "p7", total: 2, notes: [] });
  });

  it("leaves no trace when a nested session rolls back", async () => {
    await store.session(async (s) => {
      await s.session(async (sp) => {
        await sp.events.append("p8", [
          { type: "order_placed", data: { orderId: "p8", amount: 2, region: "eu" } },
        ]);
        sp.rollback();
      });
    });

    expect(await snapshotRow("p8")).toBeUndefined();
    const events = await db.sql`
      select count(*) as count from public.magpie_events where stream_id = 'p8'
    `;
    expect(events[0]?.count).toBe("0");
  });

  it("rolls back the whole write on explicit rollback", async () => {
    await expect(
      store.session(async (s) => {
        await s.events.append("c3", [
          { type: "order_placed", data: { orderId: "c3", amount: 2, region: "eu" } },
        ]);
        s.rollback();
      }),
    ).resolves.toBeUndefined();

    expect(await snapshotRow("c3")).toBeUndefined();
    const events = await db.sql`
      select count(*) as count from public.magpie_events where stream_id = 'c3'
    `;
    expect(events[0]?.count).toBe("0");
  });
});

describe("inline projection atomicity", () => {
  interface ExplosiveTick {
    n: number;
  }

  interface ExplosiveState {
    count: number;
  }

  const explosiveTickSchema = schema<ExplosiveTick>("explosive_tick", (value) => {
    const event = value as Partial<ExplosiveTick> | null;
    return typeof event?.n === "number";
  });

  const explosiveStateSchema = schema<ExplosiveState>("explosive_state", (value) => {
    const state = value as Partial<ExplosiveState> | null;
    return typeof state?.count === "number";
  });

  let db2: TestDatabase;
  let store2: Store;

  beforeAll(async () => {
    db2 = await createTestDatabase({ onnotice: () => {} });
    store2 = createStore({ sql: db2.sql });
    store2.event("explosive_tick", explosiveTickSchema);
    store2.stream("explosive", { events: ["explosive_tick"] });
    store2.aggregate(
      "explosive",
      explosiveStateSchema,
      (state, event) => {
        const stored = event as StoredEvent;
        if (stored.type === "explosive_tick") {
          throw new Error("fold exploded");
        }
        return state ?? { count: 0 };
      },
      { inline: true },
    );
    await store2.migrate();
  });

  afterAll(async () => {
    await db2.teardown();
  });

  it("rolls back the event append when the projection fold throws", async () => {
    await expect(
      store2.session(async (s) => {
        await s.events.append("boom", [{ type: "explosive_tick", data: { n: 1 } }]);
      }),
    ).rejects.toThrow("fold exploded");

    const events = await db2.sql`
      select count(*) as count from public.magpie_events where stream_id = 'boom'
    `;
    expect(events[0]?.count).toBe("0");
    const streams = await db2.sql`
      select count(*) as count from public.magpie_streams where id = 'boom'
    `;
    expect(streams[0]?.count).toBe("0");
    const snapshots = await db2.sql`
      select count(*) as count from public.magpie_doc_explosive_state where id = 'boom'
    `;
    expect(snapshots[0]?.count).toBe("0");
  });
});

describe("snapshot queryability", () => {
  it("queries projected rows through the document query surface", async () => {
    await store.session(async (s) => {
      await s.events.append("q1", [
        { type: "order_placed", data: { orderId: "q1", amount: 10, region: "eu" } },
        { type: "note_added", data: { text: "a" } },
      ]);
    });
    await store.session(async (s) => {
      await s.events.append("q2", [
        { type: "order_placed", data: { orderId: "q2", amount: 20, region: "us" } },
        { type: "note_added", data: { text: "b" } },
        { type: "note_added", data: { text: "c" } },
      ]);
    });

    const rows = await store
      .query(orderStateSchema)
      .where(store.path<OrderState>().orderId.startsWith("q"))
      .orderBy(store.path<OrderState>().total.asc())
      .toArray();
    expect(rows).toEqual([
      { orderId: "q1", total: 10, notes: ["a"] },
      { orderId: "q2", total: 20, notes: ["b", "c"] },
    ]);
  });

  it("paginates projection rows like documents", async () => {
    const page = await store
      .query(orderStateSchema)
      .where(store.path<OrderState>().orderId.startsWith("q"))
      .orderBy(store.path<OrderState>().total.asc())
      .limit(1)
      .offset(1)
      .toArray();
    expect(page.map((row) => row.orderId)).toEqual(["q2"]);
  });

  it("loads a snapshot row by id like a document", async () => {
    const loaded = await store.load(orderStateSchema, "q1");
    expect(loaded?.data).toEqual({ orderId: "q1", total: 10, notes: ["a"] });
    expect(loaded?.version).toBe(2n);
  });

  it("rejects queries over a live-only aggregate's output", () => {
    expect(() => store.query(orderRegionsSchema)).toThrow(/no stored rows/);
  });

  it("rejects loads of a live-only aggregate's output", async () => {
    await expect(store.load(orderRegionsSchema, "q1")).rejects.toThrow(/no stored rows/);
  });
});
