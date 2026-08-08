import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStore, type Store } from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "./helpers/test-db.js";

interface OrderPlaced {
  id: string;
  amount: number;
}

interface ItemAdded {
  sku: string;
  qty: number;
  note: string;
}

interface ItemRemoved {
  sku: string;
  note: string;
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
  return typeof event?.id === "string" && typeof event?.amount === "number";
});

const itemAddedSchema = schema<ItemAdded>("item_added", (value) => {
  const event = value as Partial<ItemAdded> | null;
  return (
    typeof event?.sku === "string" &&
    typeof event?.qty === "number" &&
    typeof event?.note === "string"
  );
});

const itemRemovedSchema = schema<ItemRemoved>("item_removed", (value) => {
  const event = value as Partial<ItemRemoved> | null;
  return typeof event?.sku === "string" && typeof event?.note === "string";
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
  store.event("item_added", itemAddedSchema);
  store.event("item_removed", itemRemovedSchema);
  store.stream("order", { events: ["order_placed", "item_added", "item_removed"] });
  store.upcaster("item_added", (old) => ({ ...(old as object), note: "" }));
  store.document(accountSchema, (t) => ({
    fields: [t.path.id.cast("text").primaryKey()],
  }));
  await store.migrate();
});

afterAll(async () => {
  await db.teardown();
});

describe("event validation", () => {
  it("reports no mismatches for data written through the store", async () => {
    await store.session(async (s) => {
      await s.events.append("order-1", [
        { type: "order_placed", data: { id: "o1", amount: 10 } },
        { type: "item_added", data: { sku: "a", qty: 2, note: "" } },
        { type: "item_removed", data: { sku: "a", note: "" } },
      ]);
    });

    const report = await store.validate({ streamId: "order-1" });
    expect(report.events).toBe(3);
    expect(report.documents).toBe(0);
    expect(report.mismatches).toEqual([]);
  });

  it("reports malformed rows with identifiers and issues", async () => {
    await db.sql`
      insert into magpie_events (stream_id, version, type, data)
      values ('order-2', 1, 'order_placed', ${db.sql.json({ id: "o2", amount: "not a number" })})
    `;

    const report = await store.validate({ streamId: "order-2" });
    expect(report.mismatches).toHaveLength(1);
    const [mismatch] = report.mismatches;
    expect(mismatch?.kind).toBe("event");
    if (mismatch?.kind !== "event") {
      return;
    }
    expect(mismatch.streamId).toBe("order-2");
    expect(mismatch.version).toBe(1n);
    expect(mismatch.type).toBe("order_placed");
    expect(mismatch.issues[0]?.message).toContain("invalid payload");
  });

  it("reports rows whose type has no registered shape", async () => {
    await db.sql`
      insert into magpie_events (stream_id, version, type, data)
      values ('order-3', 1, 'mystery_event', ${db.sql.json({ anything: true })})
    `;

    const report = await store.validate({ streamId: "order-3" });
    const [mismatch] = report.mismatches;
    expect(mismatch?.kind).toBe("event");
    if (mismatch?.kind !== "event") {
      return;
    }
    expect(mismatch.type).toBe("mystery_event");
    expect(mismatch.issues[0]?.message).toContain("no registered shape");
  });

  it("validates upcast output, not the raw stored shape", async () => {
    // Rows predating the note field pass only because the registered upcaster adds it.
    await db.sql`
      insert into magpie_events (stream_id, version, type, data)
      values ('order-4', 1, 'item_added', ${db.sql.json({ sku: "a", qty: 2 })})
    `;
    // The same missing field without an upcaster is a mismatch.
    await db.sql`
      insert into magpie_events (stream_id, version, type, data)
      values ('order-5', 1, 'item_removed', ${db.sql.json({ sku: "a" })})
    `;

    const withUpcaster = await store.validate({ streamId: "order-4" });
    expect(withUpcaster.mismatches).toEqual([]);

    const withoutUpcaster = await store.validate({ streamId: "order-5" });
    const [mismatch] = withoutUpcaster.mismatches;
    expect(mismatch?.kind).toBe("event");
    if (mismatch?.kind !== "event") {
      return;
    }
    expect(mismatch.streamId).toBe("order-5");
    expect(mismatch.type).toBe("item_removed");
  });

  it("scans every stream by default", async () => {
    const report = await store.validate();
    const eventStreamIds = report.mismatches
      .filter((mismatch) => mismatch.kind === "event")
      .map((mismatch) => mismatch.streamId)
      .sort();
    expect(eventStreamIds).toEqual(["order-2", "order-3", "order-5"]);
  });
});

describe("document validation", () => {
  it("scans document rows only when requested and reports malformed ones", async () => {
    await store.session(async (s) => {
      await s.documents.save(accountSchema, { id: "acct-1", balance: 10 });
    });
    await db.sql`
      insert into magpie_doc_account (id, version, data)
      values ('acct-2', 1, ${db.sql.json({ id: "acct-2", balance: "bogus" })})
    `;

    const withoutDocuments = await store.validate();
    expect(withoutDocuments.documents).toBe(0);

    const report = await store.validate({ documents: true });
    expect(report.documents).toBe(2);
    const documentMismatches = report.mismatches.filter((mismatch) => mismatch.kind === "document");
    expect(documentMismatches).toHaveLength(1);
    const [mismatch] = documentMismatches;
    expect(mismatch?.kind).toBe("document");
    if (mismatch?.kind !== "document") {
      return;
    }
    expect(mismatch.id).toBe("acct-2");
    expect(mismatch.type).toBe("account");
    expect(mismatch.issues[0]?.message).toContain("invalid payload");
  });
});

describe("read-only guarantee", () => {
  it("never modifies stored data", async () => {
    const eventsBefore = await db.sql`select * from magpie_events order by id`;
    const documentsBefore = await db.sql`select * from magpie_doc_account order by id`;

    await store.validate({ documents: true });

    const eventsAfter = await db.sql`select * from magpie_events order by id`;
    const documentsAfter = await db.sql`select * from magpie_doc_account order by id`;
    expect(eventsAfter).toEqual(eventsBefore);
    expect(documentsAfter).toEqual(documentsBefore);
  });
});
