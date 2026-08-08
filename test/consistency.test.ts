import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConcurrencyError, createStore, type Store } from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "./helpers/test-db.js";

interface OrderPlaced {
  orderId: string;
  amount: number;
  region: string;
}

interface NoteAdded {
  text: string;
}

interface Account {
  id: string;
  balance: number;
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

const accountSchema = schema<Account>("account", (value) => {
  const account = value as Partial<Account> | null;
  return typeof account?.id === "string" && typeof account?.balance === "number";
});

let db: TestDatabase;
let store: Store;

beforeAll(async () => {
  db = await createTestDatabase({ onnotice: () => {} });
  store = createStore({ sql: db.sql });
  store.event("order_placed", orderPlacedSchema);
  store.event("note_added", noteAddedSchema);
  store.stream("order", { events: ["order_placed", "note_added"] });
  store.document(accountSchema, (t) => ({
    fields: [t.path.id.cast("text").primaryKey()],
  }));
  await store.migrate();
});

afterAll(async () => {
  await db.teardown();
});

const placed = (orderId: string, amount: number, region: string): OrderPlaced => ({
  orderId,
  amount,
  region,
});

describe("concurrent appends to the same stream", () => {
  it("exactly one of two racing appends with the same expected version wins", async () => {
    await store.session(async (s) => {
      await s.events.append("race-1", [{ type: "order_placed", data: placed("race-1", 5, "eu") }]);
    });

    const settled = await Promise.allSettled([
      store.session(async (s) => {
        await s.events.append("race-1", [{ type: "note_added", data: { text: "from-a" } }], {
          expectedVersion: 1n,
        });
      }),
      store.session(async (s) => {
        await s.events.append("race-1", [{ type: "note_added", data: { text: "from-b" } }], {
          expectedVersion: 1n,
        });
      }),
    ]);

    const losers = settled.filter((result) => result.status === "rejected");
    const winners = settled.filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const [loser] = losers;
    expect(loser?.reason).toBeInstanceOf(ConcurrencyError);

    const history = await store.readStream("race-1");
    expect(history.map((event) => event.version)).toEqual([1n, 2n]);
    expect(history.map((event) => event.type)).toEqual(["order_placed", "note_added"]);
    const noteText = (history[1]?.data as NoteAdded | undefined)?.text;
    expect(["from-a", "from-b"]).toContain(noteText);
  });

  it("exactly one of two racing first appends to a missing stream wins", async () => {
    const settled = await Promise.allSettled([
      store.session(async (s) => {
        await s.events.append(
          "race-new",
          [{ type: "order_placed", data: placed("race-new", 1, "eu") }],
          {
            expectedVersion: 0n,
          },
        );
      }),
      store.session(async (s) => {
        await s.events.append(
          "race-new",
          [{ type: "order_placed", data: placed("race-new", 2, "us") }],
          {
            expectedVersion: 0n,
          },
        );
      }),
    ]);

    const losers = settled.filter((result) => result.status === "rejected");
    const winners = settled.filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const [loser] = losers;
    expect(loser?.reason).toBeInstanceOf(ConcurrencyError);

    const history = await store.readStream("race-new");
    expect(history).toHaveLength(1);
    expect(history[0]?.version).toBe(1n);
    const winningAmount = (history[0]?.data as OrderPlaced | undefined)?.amount;
    expect([1, 2]).toContain(winningAmount);
  });
});

describe("concurrent appends to different streams", () => {
  it("both appends succeed without interference", async () => {
    await Promise.all([
      store.session(async (s) => {
        await s.events.append("race-d1", [
          { type: "order_placed", data: placed("race-d1", 1, "eu") },
        ]);
      }),
      store.session(async (s) => {
        await s.events.append("race-d2", [
          { type: "order_placed", data: placed("race-d2", 2, "us") },
        ]);
      }),
    ]);

    const first = await store.readStream("race-d1");
    const second = await store.readStream("race-d2");
    expect(first.map((event) => event.version)).toEqual([1n]);
    expect(second.map((event) => event.version)).toEqual([1n]);
  });
});

const account = (id: string, balance: number): Account => ({ id, balance });

describe("concurrent saves of the same document", () => {
  it("exactly one of two racing saves with the same expected version wins", async () => {
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("doc-1", 5));
    });

    const settled = await Promise.allSettled([
      store.session(async (s) => {
        await s.documents.save(accountSchema, account("doc-1", 10), { expectedVersion: 1n });
      }),
      store.session(async (s) => {
        await s.documents.save(accountSchema, account("doc-1", 20), { expectedVersion: 1n });
      }),
    ]);

    const winners = settled.filter((result) => result.status === "fulfilled");
    const losers = settled.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const [loser] = losers;
    expect(loser?.reason).toBeInstanceOf(ConcurrencyError);

    const loaded = await store.load(accountSchema, "doc-1");
    expect(loaded?.version).toBe(2n);
    expect([10, 20]).toContain(loaded?.data.balance);
  });

  it("exactly one of two racing first saves of a missing document wins", async () => {
    const settled = await Promise.allSettled([
      store.session(async (s) => {
        await s.documents.save(accountSchema, account("doc-new", 10));
      }),
      store.session(async (s) => {
        await s.documents.save(accountSchema, account("doc-new", 20));
      }),
    ]);

    const winners = settled.filter((result) => result.status === "fulfilled");
    const losers = settled.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const [loser] = losers;
    expect(loser?.reason).toBeInstanceOf(ConcurrencyError);

    const loaded = await store.load(accountSchema, "doc-new");
    expect(loaded?.version).toBe(1n);
    expect([10, 20]).toContain(loaded?.data.balance);
  });

  it("lets both racing saves with the bypass succeed, each advancing the version", async () => {
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("doc-any", 5));
    });

    const settled = await Promise.allSettled([
      store.session(async (s) => {
        await s.documents.save(accountSchema, account("doc-any", 10), {
          expectedVersion: "any",
        });
      }),
      store.session(async (s) => {
        await s.documents.save(accountSchema, account("doc-any", 20), {
          expectedVersion: "any",
        });
      }),
    ]);

    const rejected = settled.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(0);

    const loaded = await store.load(accountSchema, "doc-any");
    expect(loaded?.version).toBe(3n);
    expect([10, 20]).toContain(loaded?.data.balance);
  });
});
