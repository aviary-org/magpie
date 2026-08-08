import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStore, type Store } from "../src/index.js";
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
