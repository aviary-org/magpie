import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConcurrencyError, createStore, type Store, ValidationError } from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "./helpers/test-db.js";

interface Account {
  id: string;
  balance: number;
}

interface OrderPlaced {
  orderId: string;
  amount: number;
}

interface OrderShipped {
  orderId: string;
}

interface NoteAdded {
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

const accountSchema = schema<Account>("account", (value) => {
  const account = value as Partial<Account> | null;
  return typeof account?.id === "string" && typeof account?.balance === "number";
});

const orderPlacedSchema = schema<OrderPlaced>("order_placed", (value) => {
  const event = value as Partial<OrderPlaced> | null;
  return typeof event?.orderId === "string" && typeof event?.amount === "number";
});

const orderShippedSchema = schema<OrderShipped>("order_shipped", () => true);
const noteAddedSchema = schema<NoteAdded>("note_added", (value) => {
  const event = value as Partial<NoteAdded> | null;
  return typeof event?.text === "string";
});

const account = (id: string, balance: number): Account => ({ id, balance });
const orderPlaced = (orderId: string, amount: number): OrderPlaced => ({ orderId, amount });

let db: TestDatabase;
let store: Store;

beforeAll(async () => {
  db = await createTestDatabase({ onnotice: () => {} });
  store = createStore({ sql: db.sql });
  store.document(accountSchema, (t) => ({
    fields: [t.path.id.cast("text").primaryKey()],
  }));
  store.event("order_placed", orderPlacedSchema);
  store.event("order_shipped", orderShippedSchema);
  store.event("note_added", noteAddedSchema);
  store.stream("order", { events: ["order_placed", "order_shipped"] });
  await store.migrate();
});

afterAll(async () => {
  await db.teardown();
});

describe("store.session", () => {
  it("commits document saves and event appends together", async () => {
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("acct-1", 10));
      await s.events.append("acct-1", [
        { type: "order_placed", data: orderPlaced("o1", 5) },
        { type: "order_shipped", data: { orderId: "o1" } },
      ]);
    });

    const docs =
      await db.sql`select id, version, data from public.magpie_doc_account where id = 'acct-1'`;
    expect(docs.length).toBe(1);
    expect(docs[0]?.version).toBe("1");
    expect(docs[0]?.data).toEqual(account("acct-1", 10));

    const events = await db.sql`
      select version, type from public.magpie_events where stream_id = 'acct-1' order by version
    `;
    expect(events.map((row) => row.version)).toEqual(["1", "2"]);
    expect(events.map((row) => row.type)).toEqual(["order_placed", "order_shipped"]);

    const streams =
      await db.sql`select version, type from public.magpie_streams where id = 'acct-1'`;
    expect(streams[0]?.version).toBe("2");
    expect(streams[0]?.type).toBe("order");
  });

  it("resolves with the callback's value on commit", async () => {
    const result = await store.session(async (s) => {
      await s.documents.save(accountSchema, account("acct-2", 1));
      return "committed";
    });
    expect(result).toBe("committed");
  });

  it("rolls back everything when the callback throws", async () => {
    await expect(
      store.session(async (s) => {
        await s.documents.save(accountSchema, account("acct-3", 1));
        await s.events.append("acct-3", [
          { type: "order_placed", data: orderPlaced("o1", 1) },
          { type: "order_shipped", data: { orderId: "o1" } },
        ]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const docs = await db.sql`select id from public.magpie_doc_account where id = 'acct-3'`;
    expect(docs.length).toBe(0);
    const streams = await db.sql`select id from public.magpie_streams where id = 'acct-3'`;
    expect(streams.length).toBe(0);
  });

  it("persists nothing on explicit rollback and resolves undefined", async () => {
    const result = await store.session(async (s) => {
      await s.documents.save(accountSchema, account("acct-4", 1));
      s.rollback();
    });
    expect(result).toBeUndefined();

    const docs = await db.sql`select id from public.magpie_doc_account where id = 'acct-4'`;
    expect(docs.length).toBe(0);
  });

  it("rejects invalid documents with issues before any SQL", async () => {
    const invalid = { id: "acct-5" } as unknown as Account;
    await expect(
      store.session(async (s) => {
        await s.documents.save(accountSchema, invalid);
      }),
    ).rejects.toThrow(ValidationError);

    const docs = await db.sql`select id from public.magpie_doc_account where id = 'acct-5'`;
    expect(docs.length).toBe(0);
  });

  it("rejects appends of unregistered event names", async () => {
    await expect(
      store.session(async (s) => {
        await s.events.append("stream-x", [{ type: "never_registered", data: {} }]);
      }),
    ).rejects.toThrow(/no registered shape/);
  });

  it("rejects appends whose payloads fail validation", async () => {
    await expect(
      store.session(async (s) => {
        await s.events.append("stream-y", [{ type: "order_placed", data: { orderId: 5 } }]);
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects empty appends", async () => {
    await expect(
      store.session(async (s) => {
        await s.events.append("stream-z", []);
      }),
    ).rejects.toThrow(/at least one event/);
  });
});

describe("document save versions", () => {
  it("advances versions and enforces the expected version", async () => {
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("ver-1", 1));
    });
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("ver-1", 2), { expectedVersion: 1n });
    });

    await expect(
      store.session(async (s) => {
        await s.documents.save(accountSchema, account("ver-1", 3), { expectedVersion: 1n });
      }),
    ).rejects.toThrow(ConcurrencyError);

    const rows = await db.sql`select version from public.magpie_doc_account where id = 'ver-1'`;
    expect(rows[0]?.version).toBe("2");
  });

  it("treats an omitted expected version as must-not-exist", async () => {
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("ver-2", 1));
    });
    await expect(
      store.session(async (s) => {
        await s.documents.save(accountSchema, account("ver-2", 2));
      }),
    ).rejects.toThrow(ConcurrencyError);
  });

  it("supports an explicit must-not-exist expected version of zero", async () => {
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("ver-3", 1), { expectedVersion: 0n });
    });
    await expect(
      store.session(async (s) => {
        await s.documents.save(accountSchema, account("ver-3", 2), { expectedVersion: 0n });
      }),
    ).rejects.toThrow(ConcurrencyError);
  });

  it("rejects a save expecting an existing row when none exists", async () => {
    await expect(
      store.session(async (s) => {
        await s.documents.save(accountSchema, account("ver-4", 1), { expectedVersion: 3n });
      }),
    ).rejects.toThrow(ConcurrencyError);
  });

  it("bypasses the version guard with the any expected version", async () => {
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("ver-5", 1));
    });
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("ver-5", 2), { expectedVersion: "any" });
    });
    const rows = await db.sql`select version from public.magpie_doc_account where id = 'ver-5'`;
    expect(rows[0]?.version).toBe("2");
  });
});

describe("event append semantics", () => {
  it("auto-creates a stream with consecutive versions from version one", async () => {
    await store.session(async (s) => {
      await s.events.append("stream-1", [
        { type: "order_placed", data: orderPlaced("o1", 1) },
        { type: "order_shipped", data: { orderId: "o1" } },
        { type: "order_placed", data: orderPlaced("o2", 2) },
      ]);
    });

    const streams =
      await db.sql`select version, type from public.magpie_streams where id = 'stream-1'`;
    expect(streams[0]?.version).toBe("3");
    expect(streams[0]?.type).toBe("order");

    const events = await db.sql`
      select version, type from public.magpie_events where stream_id = 'stream-1' order by version
    `;
    expect(events.map((row) => row.version)).toEqual(["1", "2", "3"]);
  });

  it("creates an untyped stream for events no registration governs", async () => {
    await store.session(async (s) => {
      await s.events.append("stream-2", [{ type: "note_added", data: { text: "hello" } }]);
    });
    const streams =
      await db.sql`select version, type from public.magpie_streams where id = 'stream-2'`;
    expect(streams[0]?.version).toBe("1");
    expect(streams[0]?.type).toBeNull();
  });

  it("rejects events outside an existing stream's contract", async () => {
    await store.session(async (s) => {
      await s.events.append("stream-3", [{ type: "order_placed", data: orderPlaced("o1", 1) }]);
    });

    await expect(
      store.session(async (s) => {
        await s.events.append("stream-3", [{ type: "note_added", data: { text: "x" } }]);
      }),
    ).rejects.toThrow(/not allowed/);

    const events = await db.sql`select type from public.magpie_events where stream_id = 'stream-3'`;
    expect(events.map((row) => row.type)).toEqual(["order_placed"]);
  });

  it("enforces the expected stream version on append", async () => {
    await store.session(async (s) => {
      await s.events.append("stream-4", [{ type: "order_placed", data: orderPlaced("o1", 1) }], {
        expectedVersion: 0n,
      });
    });

    await expect(
      store.session(async (s) => {
        await s.events.append("stream-4", [{ type: "order_placed", data: orderPlaced("o2", 2) }], {
          expectedVersion: 0n,
        });
      }),
    ).rejects.toThrow(ConcurrencyError);

    await store.session(async (s) => {
      await s.events.append("stream-4", [{ type: "order_placed", data: orderPlaced("o3", 3) }], {
        expectedVersion: 1n,
      });
    });

    await expect(
      store.session(async (s) => {
        await s.events.append("stream-4", [{ type: "order_placed", data: orderPlaced("o4", 4) }], {
          expectedVersion: 1n,
        });
      }),
    ).rejects.toThrow(ConcurrencyError);

    const streams = await db.sql`select version from public.magpie_streams where id = 'stream-4'`;
    expect(streams[0]?.version).toBe("2");
  });

  it("rejects an append expecting an existing stream when none exists", async () => {
    await expect(
      store.session(async (s) => {
        await s.events.append("stream-5", [{ type: "order_placed", data: orderPlaced("o1", 1) }], {
          expectedVersion: 2n,
        });
      }),
    ).rejects.toThrow(ConcurrencyError);
  });

  it("rejects appends whose events match multiple stream registrations", async () => {
    const ambiguous = createStore({ sql: db.sql });
    ambiguous.event("order_placed", orderPlacedSchema);
    ambiguous.stream("order", { events: ["order_placed"] });
    ambiguous.stream("sales", { events: ["order_placed"] });
    await ambiguous.migrate();

    await expect(
      ambiguous.session(async (s) => {
        await s.events.append("stream-6", [{ type: "order_placed", data: orderPlaced("o1", 1) }]);
      }),
    ).rejects.toThrow(/multiple stream registrations/);
  });
});

describe("session atomicity", () => {
  it("rolls back queued document saves when a queued append fails", async () => {
    await store.session(async (s) => {
      await s.events.append("atomic-1", [{ type: "order_placed", data: orderPlaced("o1", 1) }]);
    });

    await expect(
      store.session(async (s) => {
        await s.documents.save(accountSchema, account("atomic-1", 1));
        await s.events.append("atomic-1", [{ type: "order_placed", data: orderPlaced("o2", 2) }], {
          expectedVersion: 99n,
        });
      }),
    ).rejects.toThrow(ConcurrencyError);

    const docs = await db.sql`select id from public.magpie_doc_account where id = 'atomic-1'`;
    expect(docs.length).toBe(0);
    const events =
      await db.sql`select version from public.magpie_events where stream_id = 'atomic-1'`;
    expect(events.map((row) => row.version)).toEqual(["1"]);
  });

  it("commits nested session work with the outer session", async () => {
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("nested-1", 1));
      await s.session(async (sp) => {
        await sp.documents.save(accountSchema, account("nested-2", 2));
      });
    });

    const rows = await db.sql`
      select id from public.magpie_doc_account where id in ('nested-1', 'nested-2') order by id
    `;
    expect(rows.map((row) => row.id)).toEqual(["nested-1", "nested-2"]);
  });

  it("rolls back only the inner work on a nested rollback", async () => {
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("nested-3", 1));
      await s.session(async (sp) => {
        await sp.documents.save(accountSchema, account("nested-4", 2));
        sp.rollback();
      });
      await s.documents.save(accountSchema, account("nested-5", 3));
    });

    const rows = await db.sql`
      select id from public.magpie_doc_account where id in ('nested-3', 'nested-4', 'nested-5') order by id
    `;
    expect(rows.map((row) => row.id)).toEqual(["nested-3", "nested-5"]);
  });

  it("rolls back only the inner work when a nested session throws and the error is caught", async () => {
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("nested-6", 1));
      await s
        .session(async (sp) => {
          await sp.documents.save(accountSchema, account("nested-7", 2));
          throw new Error("inner boom");
        })
        .catch((error: unknown) => {
          expect((error as Error).message).toBe("inner boom");
        });
      await s.documents.save(accountSchema, account("nested-8", 3));
    });

    const rows = await db.sql`
      select id from public.magpie_doc_account where id in ('nested-6', 'nested-7', 'nested-8') order by id
    `;
    expect(rows.map((row) => row.id)).toEqual(["nested-6", "nested-8"]);
  });
});

describe("session concurrency", () => {
  it("lets exactly one concurrent append win per version", async () => {
    await store.session(async (s) => {
      await s.events.append("race-1", [{ type: "order_placed", data: orderPlaced("o1", 1) }]);
    });

    const results = await Promise.allSettled([
      store.session(async (s) => {
        await s.events.append("race-1", [{ type: "order_shipped", data: { orderId: "o1" } }], {
          expectedVersion: 1n,
        });
      }),
      store.session(async (s) => {
        await s.events.append("race-1", [{ type: "order_shipped", data: { orderId: "o1" } }], {
          expectedVersion: 1n,
        });
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const reason = rejected.at(0)?.status === "rejected" ? rejected.at(0)?.reason : undefined;
    expect(reason).toBeInstanceOf(ConcurrencyError);

    const streams = await db.sql`select version from public.magpie_streams where id = 'race-1'`;
    expect(streams[0]?.version).toBe("2");
    const events = await db.sql`
      select count(*)::int as n from public.magpie_events where stream_id = 'race-1'
    `;
    expect(events[0]?.n).toBe(2);
  });

  it("lets exactly one concurrent first append win", async () => {
    const results = await Promise.allSettled([
      store.session(async (s) => {
        await s.events.append("race-2", [
          { type: "order_placed", data: orderPlaced("o1", 1) },
          { type: "order_shipped", data: { orderId: "o1" } },
        ]);
      }),
      store.session(async (s) => {
        await s.events.append("race-2", [
          { type: "order_placed", data: orderPlaced("o2", 2) },
          { type: "order_shipped", data: { orderId: "o2" } },
        ]);
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const reason = rejected.at(0)?.status === "rejected" ? rejected.at(0)?.reason : undefined;
    expect(reason).toBeInstanceOf(ConcurrencyError);

    const streams = await db.sql`select version from public.magpie_streams where id = 'race-2'`;
    expect(streams[0]?.version).toBe("2");
  });

  it("auto-creates schema on demand when autoCreate is enabled", async () => {
    const auto = createStore({ sql: db.sql, autoCreate: true });
    auto.document(accountSchema, (t) => ({
      fields: [t.path.id.cast("text").primaryKey()],
    }));
    await auto.session(async (s) => {
      await s.documents.save(accountSchema, account("auto-1", 1));
    });

    const rows = await db.sql`select id from public.magpie_doc_account where id = 'auto-1'`;
    expect(rows.length).toBe(1);
  });
});
