import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStore, type FoldFn, type Store, type StoredEvent } from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "./helpers/test-db.js";

interface OrderPlacedV2 {
  orderId: string;
  amount: number;
  region: string;
}

interface OrderCancelled {
  orderId: string;
  reason: string;
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

const orderPlacedV2Schema = schema<OrderPlacedV2>("order_placed_v2", (value) => {
  const event = value as Partial<OrderPlacedV2> | null;
  return (
    typeof event?.orderId === "string" &&
    typeof event?.amount === "number" &&
    typeof event?.region === "string"
  );
});

const orderCancelledSchema = schema<OrderCancelled>("order_cancelled", (value) => {
  const event = value as Partial<OrderCancelled> | null;
  return typeof event?.orderId === "string" && typeof event?.reason === "string";
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

const foldOrderState: FoldFn = (state, event) => {
  const current = (state ?? { orderId: "", total: 0, notes: [] }) as OrderState;
  const stored = event as StoredEvent;
  switch (stored.type) {
    case "order_placed_v2": {
      const placed = stored.data as OrderPlacedV2;
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
  if (stored.type === "order_placed" || stored.type === "order_placed_v2") {
    return { regions: [...regions, (stored.data as OrderPlacedV2).region] };
  }
  return { regions };
};

let db: TestDatabase;
let store: Store;

beforeAll(async () => {
  db = await createTestDatabase({ onnotice: () => {} });
  store = createStore({ sql: db.sql });
  // The old stored name is registered with the current shape: the read path validates
  // upcaster output against the shape registered under the stored name.
  store.event("order_placed", orderPlacedV2Schema);
  store.event("order_placed_v2", orderPlacedV2Schema);
  store.event("order_cancelled", orderCancelledSchema);
  store.event("note_added", noteAddedSchema);
  store.upcaster("order_placed", (old) => ({ ...(old as object), region: "eu" }));
  store.upcaster("order_cancelled", () => ({ broken: true }));
  store.stream("order", {
    events: ["order_placed", "order_placed_v2", "order_cancelled", "note_added"],
  });
  store.aggregate("order", orderStateSchema, foldOrderState);
  store.aggregate("order", orderRegionsSchema, foldOrderRegions);
  await store.migrate();
});

afterAll(async () => {
  await db.teardown();
});

describe("read stream history", () => {
  it("reads the full history in order with round-tripped data", async () => {
    await store.session(async (s) => {
      await s.events.append("o1", [
        { type: "order_placed_v2", data: { orderId: "o1", amount: 5, region: "eu" } },
        { type: "note_added", data: { text: "hello" } },
        { type: "order_placed_v2", data: { orderId: "o1", amount: 7, region: "us" } },
      ]);
    });

    const history = await store.readStream("o1");
    expect(history.map((event) => event.version)).toEqual([1n, 2n, 3n]);
    expect(history.map((event) => event.type)).toEqual([
      "order_placed_v2",
      "note_added",
      "order_placed_v2",
    ]);
    expect(history[0]?.data).toEqual({ orderId: "o1", amount: 5, region: "eu" });
    expect(history[1]?.data).toEqual({ text: "hello" });
  });

  it("reads a slice starting at a given version", async () => {
    await store.session(async (s) => {
      await s.events.append("o2", [
        { type: "order_placed_v2", data: { orderId: "o2", amount: 1, region: "eu" } },
        { type: "order_placed_v2", data: { orderId: "o2", amount: 2, region: "eu" } },
        { type: "order_placed_v2", data: { orderId: "o2", amount: 3, region: "eu" } },
        { type: "order_placed_v2", data: { orderId: "o2", amount: 4, region: "eu" } },
      ]);
    });

    const slice = await store.readStream("o2", { fromVersion: 3n });
    expect(slice.map((event) => event.version)).toEqual([3n, 4n]);
  });

  it("reads an absent stream as an empty history", async () => {
    await expect(store.readStream("never-was")).resolves.toEqual([]);
  });

  it("upcasts old-shaped rows at read time and never rewrites storage", async () => {
    await db.sql`
      insert into public.magpie_streams (id, version, type) values ('o3', 1, 'order')
    `;
    await db.sql`
      insert into public.magpie_events (stream_id, version, type, data)
      values ('o3', 1, 'order_placed', ${db.sql.json({ orderId: "o3", amount: 5 })})
    `;
    await store.session(async (s) => {
      await s.events.append("o3", [
        { type: "order_placed_v2", data: { orderId: "o3", amount: 9, region: "ap" } },
      ]);
    });

    const history = await store.readStream("o3");
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({
      type: "order_placed",
      data: { orderId: "o3", amount: 5, region: "eu" },
      version: 1n,
    });

    const stored = await db.sql`
      select data from public.magpie_events where stream_id = 'o3' and version = 1
    `;
    expect(stored[0]?.data).toEqual({ orderId: "o3", amount: 5 });
  });

  it("rejects a read when an upcaster produces data that fails validation", async () => {
    await db.sql`
      insert into public.magpie_streams (id, version, type) values ('o4', 1, 'order')
    `;
    await db.sql`
      insert into public.magpie_events (stream_id, version, type, data)
      values ('o4', 1, 'order_cancelled', ${db.sql.json({ orderId: "o4", reason: "late" })})
    `;

    await expect(store.readStream("o4")).rejects.toMatchObject({
      name: "ValidationError",
      issues: [{ message: expect.any(String) }],
    });
  });

  it("returns stored rows without re-validation when no upcaster applies", async () => {
    await db.sql`
      insert into public.magpie_streams (id, version, type) values ('o5', 1, 'order')
    `;
    await db.sql`
      insert into public.magpie_events (stream_id, version, type, data)
      values ('o5', 1, 'note_added', ${db.sql.json({ notTheShape: true })})
    `;

    const history = await store.readStream("o5");
    expect(history).toHaveLength(1);
    expect(history[0]?.data).toEqual({ notTheShape: true });
  });
});

describe("on-demand aggregation", () => {
  it("folds a stream's events into the aggregate state", async () => {
    await store.session(async (s) => {
      await s.events.append("f1", [
        { type: "order_placed_v2", data: { orderId: "f1", amount: 5, region: "eu" } },
        { type: "note_added", data: { text: "hello" } },
        { type: "order_placed_v2", data: { orderId: "f1", amount: 7, region: "us" } },
      ]);
    });

    const state = await store.fold(orderStateSchema, "f1");
    expect(state).toEqual({ orderId: "f1", total: 12, notes: ["hello"] });
  });

  it("returns nothing for a stream that never had events", async () => {
    await expect(store.fold(orderStateSchema, "never-folded")).resolves.toBeUndefined();
  });

  it("never persists the aggregate and recomputes on every fold", async () => {
    await store.fold(orderStateSchema, "f1");

    const tables = await db.sql`
      select tablename from pg_tables
      where schemaname = 'public' and tablename like 'magpie_doc_%'
    `;
    expect(tables.length).toBe(0);
    const events =
      await db.sql`select count(*) as count from public.magpie_events where stream_id = 'f1'`;
    expect(events[0]?.count).toBe("3");

    await expect(store.fold(orderStateSchema, "f1")).resolves.toEqual({
      orderId: "f1",
      total: 12,
      notes: ["hello"],
    });
  });

  it("feeds upcast events to the fold", async () => {
    await db.sql`
      insert into public.magpie_streams (id, version, type) values ('f2', 1, 'order')
    `;
    await db.sql`
      insert into public.magpie_events (stream_id, version, type, data)
      values ('f2', 1, 'order_placed', ${db.sql.json({ orderId: "f2", amount: 5 })})
    `;
    await store.session(async (s) => {
      await s.events.append("f2", [
        { type: "order_placed_v2", data: { orderId: "f2", amount: 9, region: "ap" } },
      ]);
    });

    const regions = await store.fold(orderRegionsSchema, "f2");
    expect(regions).toEqual({ regions: ["eu", "ap"] });
  });

  it("lets two aggregates fold the same stream independently", async () => {
    const state = await store.fold(orderStateSchema, "f2");
    const regions = await store.fold(orderRegionsSchema, "f2");
    expect(state).toEqual({ orderId: "f2", total: 9, notes: [] });
    expect(regions).toEqual({ regions: ["eu", "ap"] });
  });

  it("rejects folding with an unregistered output schema", async () => {
    const unregisteredSchema = schema<{ x: string }>("unregistered", () => true);
    await expect(store.fold(unregisteredSchema, "f1")).rejects.toThrow(
      "fold: the given schema is not registered as an aggregate output",
    );
  });

  it("rejects a second aggregate with the same output schema", () => {
    const duplicateSchema = schema<{ y: string }>("duplicate", () => true);
    store.aggregate("order", duplicateSchema, () => undefined);
    expect(() => store.aggregate("order", duplicateSchema, () => undefined)).toThrow(
      /an aggregate with this output schema is already registered/,
    );
  });
});
