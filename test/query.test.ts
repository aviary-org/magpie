import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, createStore, or, type Store } from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "./helpers/test-db.js";

interface Address {
  city: string;
  zip: string;
}

interface Customer {
  id: string;
  name: string;
  balance: number;
  score: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  nickname?: string;
  tags: readonly string[];
  address: Address;
}

interface Item {
  id: string;
  sku: string;
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

const customerSchema = schema<Customer>("customer", (value) => {
  const customer = value as Partial<Customer> | null;
  return (
    typeof customer?.id === "string" &&
    typeof customer?.name === "string" &&
    typeof customer?.balance === "number" &&
    typeof customer?.score === "number" &&
    typeof customer?.active === "boolean" &&
    customer?.createdAt instanceof Date &&
    customer?.updatedAt instanceof Date &&
    Array.isArray(customer?.tags) &&
    customer.tags.every((tag) => typeof tag === "string") &&
    typeof customer?.address?.city === "string" &&
    typeof customer?.address?.zip === "string" &&
    (customer?.nickname === undefined || typeof customer?.nickname === "string")
  );
});

const itemSchema = schema<Item>("item", (value) => {
  const item = value as Partial<Item> | null;
  return typeof item?.id === "string" && typeof item?.sku === "string";
});

const customer = (id: string, overrides: Partial<Customer> = {}): Customer => ({
  id,
  name: "Alice",
  balance: 100,
  score: 50,
  active: true,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
  tags: [],
  address: { city: "Boston", zip: "02108" },
  ...overrides,
});

let db: TestDatabase;
let store: Store;

beforeAll(async () => {
  db = await createTestDatabase({ onnotice: () => {} });
  store = createStore({ sql: db.sql });
  store.document(customerSchema, (t) => ({
    fields: [
      t.path.id.cast("text").primaryKey(),
      t.path.balance.cast("numeric").index(),
      t.path.createdAt.cast("timestamptz").index(),
      t.path.address.city.index(),
      t.path.tags.containsIndex(),
    ],
  }));
  store.document(itemSchema, (t) => ({
    fields: [t.path.id.cast("uuid").primaryKey()],
  }));
  await store.migrate();
  await store.session(async (session) => {
    await session.documents.save(
      customerSchema,
      customer("c1", {
        name: "Alice",
        balance: 150,
        score: 90,
        active: true,
        createdAt: new Date("2024-01-15T00:00:00Z"),
        updatedAt: new Date("2024-01-20T00:00:00Z"),
        nickname: "Ali",
        tags: ["sale", "vip"],
        address: { city: "Boston", zip: "02108" },
      }),
    );
    await session.documents.save(
      customerSchema,
      customer("c2", {
        name: "Bob",
        balance: 50,
        score: 40,
        active: false,
        createdAt: new Date("2024-02-15T00:00:00Z"),
        updatedAt: new Date("2024-02-20T00:00:00Z"),
        tags: ["sale"],
        address: { city: "NYC", zip: "10001" },
      }),
    );
    await session.documents.save(
      customerSchema,
      customer("c3", {
        name: "Carol",
        balance: 300,
        score: 80,
        active: true,
        createdAt: new Date("2024-03-15T00:00:00Z"),
        updatedAt: new Date("2024-03-20T00:00:00Z"),
        nickname: "C",
        tags: [],
        address: { city: "Boston", zip: "02110" },
      }),
    );
    await session.documents.save(itemSchema, {
      id: "00000000-0000-4000-8000-000000000001",
      sku: "widget",
    });
  });
});

afterAll(async () => {
  await db.teardown();
});

describe("store.path", () => {
  it("builds typed conditions over nested fields", () => {
    const $ = store.path<Customer>();
    expect($.address.city.eq("Boston")).toEqual({
      kind: "leaf",
      path: ["address", "city"],
      op: "eq",
      value: "Boston",
    });
  });

  it("rejects an empty in-list at build time", () => {
    const $ = store.path<Customer>();
    expect(() => $.name.in([])).toThrow("in: at least one value is required");
  });

  it("builds and/or compositions", () => {
    const $ = store.path<Customer>();
    expect(and($.active.eq(true), $.balance.gte(100)).kind).toBe("and");
    expect(or($.active.eq(true), $.balance.gte(100)).kind).toBe("or");
  });
});

describe("store.query", () => {
  it("filters on nested fields", async () => {
    const $ = store.path<Customer>();
    const rows = await store.query(customerSchema).where($.address.city.eq("Boston")).toArray();
    expect(rows.map((row) => row.id).sort()).toEqual(["c1", "c3"]);
  });

  it("combines conditions with and", async () => {
    const $ = store.path<Customer>();
    const rows = await store
      .query(customerSchema)
      .where(and($.active.eq(true), $.balance.gte(100)))
      .toArray();
    expect(rows.map((row) => row.id).sort()).toEqual(["c1", "c3"]);
  });

  it("combines conditions with or", async () => {
    const $ = store.path<Customer>();
    const rows = await store
      .query(customerSchema)
      .where(or($.address.city.eq("NYC"), $.name.eq("Carol")))
      .toArray();
    expect(rows.map((row) => row.id).sort()).toEqual(["c2", "c3"]);
  });

  it("accepts several conditions in one where call", async () => {
    const $ = store.path<Customer>();
    const rows = await store
      .query(customerSchema)
      .where($.address.city.eq("Boston"), $.active.eq(true))
      .toArray();
    expect(rows.map((row) => row.id).sort()).toEqual(["c1", "c3"]);
  });

  it("sorts and paginates", async () => {
    const $ = store.path<Customer>();
    const rows = await store
      .query(customerSchema)
      .orderBy($.balance.desc())
      .limit(2)
      .offset(1)
      .toArray();
    expect(rows.map((row) => row.id)).toEqual(["c1", "c2"]);
  });

  it("sorts by multiple terms in priority order", async () => {
    const $ = store.path<Customer>();
    const rows = await store
      .query(customerSchema)
      .orderBy($.address.city.asc(), $.balance.desc())
      .toArray();
    expect(rows.map((row) => row.id)).toEqual(["c3", "c1", "c2"]);
  });

  it("compares numbers with the default numeric cast", async () => {
    const $ = store.path<Customer>();
    const rows = await store.query(customerSchema).where($.score.gte(80)).toArray();
    expect(rows.map((row) => row.id).sort()).toEqual(["c1", "c3"]);
  });

  it("compares numbers with the registered cast", async () => {
    const $ = store.path<Customer>();
    const rows = await store.query(customerSchema).where($.balance.between(100, 200)).toArray();
    expect(rows.map((row) => row.id)).toEqual(["c1"]);
  });

  it("compares dates through the wrapper cast", async () => {
    const $ = store.path<Customer>();
    const rows = await store
      .query(customerSchema)
      .where($.createdAt.gt(new Date("2024-02-01T00:00:00Z")))
      .toArray();
    expect(rows.map((row) => row.id)).toEqual(["c2", "c3"]);
  });

  it("applies the default date cast to unregistered fields", async () => {
    const $ = store.path<Customer>();
    const rows = await store
      .query(customerSchema)
      .where($.updatedAt.lt(new Date("2024-02-01T00:00:00Z")))
      .toArray();
    expect(rows.map((row) => row.id)).toEqual(["c1"]);
  });

  it("compares booleans", async () => {
    const $ = store.path<Customer>();
    const rows = await store.query(customerSchema).where($.active.eq(false)).toArray();
    expect(rows.map((row) => row.id)).toEqual(["c2"]);
  });

  it("matches string prefixes and suffixes", async () => {
    const $ = store.path<Customer>();
    const prefixed = await store.query(customerSchema).where($.name.startsWith("Al")).toArray();
    expect(prefixed.map((row) => row.id)).toEqual(["c1"]);
    const suffixed = await store.query(customerSchema).where($.name.endsWith("ol")).toArray();
    expect(suffixed.map((row) => row.id)).toEqual(["c3"]);
  });

  it("matches a list of values", async () => {
    const $ = store.path<Customer>();
    const rows = await store
      .query(customerSchema)
      .where($.address.city.in(["NYC", "Chicago"]))
      .toArray();
    expect(rows.map((row) => row.id)).toEqual(["c2"]);
  });

  it("matches missing or null fields", async () => {
    const $ = store.path<Customer>();
    const missing = await store.query(customerSchema).where($.nickname.isNull()).toArray();
    expect(missing.map((row) => row.id)).toEqual(["c2"]);
    const present = await store.query(customerSchema).where($.nickname.notNull()).toArray();
    expect(present.map((row) => row.id).sort()).toEqual(["c1", "c3"]);
  });

  it("contains array elements via jsonb containment", async () => {
    const $ = store.path<Customer>();
    const rows = await store
      .query(customerSchema)
      .where($.tags.contains(["sale"]))
      .toArray();
    expect(rows.map((row) => row.id).sort()).toEqual(["c1", "c2"]);
  });

  it("contains nested objects via jsonb containment", async () => {
    const $ = store.path<Customer>();
    const rows = await store
      .query(customerSchema)
      .where($.address.contains({ city: "Boston" }))
      .toArray();
    expect(rows.map((row) => row.id).sort()).toEqual(["c1", "c3"]);
  });

  it("compares uuid-cast id fields", async () => {
    const $ = store.path<Item>();
    const rows = await store
      .query(itemSchema)
      .where($.id.eq("00000000-0000-4000-8000-000000000001"))
      .toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sku).toBe("widget");
  });

  it("excludes soft-deleted documents", async () => {
    await store.session(async (session) => {
      await session.documents.delete(customerSchema, "c1");
    });
    const rows = await store.query(customerSchema).toArray();
    expect(rows.map((row) => row.id).sort()).toEqual(["c2", "c3"]);
  });

  it("rejects queries over unregistered schemas", () => {
    const unregistered = schema<Customer>("ghost", () => true);
    expect(() => store.query(unregistered)).toThrow("query: the given schema is not registered");
  });

  it("rejects a negative limit and offset", () => {
    const query = store.query(customerSchema);
    expect(() => query.limit(-1)).toThrow("limit must be a non-negative integer");
    expect(() => query.offset(-1)).toThrow("offset must be a non-negative integer");
  });
});

describe("query storage metadata", () => {
  it("creates duplicated columns for indexed fields", async () => {
    const rows = await db.sql`
      select column_name from information_schema.columns
      where table_name = 'magpie_doc_customer' and column_name in ('f_balance', 'f_createdAt', 'f_address_city')
    `;
    expect(rows.map((row) => row.column_name).sort()).toEqual([
      "f_address_city",
      "f_balance",
      "f_createdAt",
    ]);
  });

  it("creates btree and gin indexes from the config callback", async () => {
    const rows = await db.sql`
      select indexname from pg_indexes
      where tablename = 'magpie_doc_customer'
      and indexname in ('magpie_doc_customer_f_balance_idx', 'magpie_doc_customer_data_gin')
    `;
    expect(rows.map((row) => row.indexname).sort()).toEqual([
      "magpie_doc_customer_data_gin",
      "magpie_doc_customer_f_balance_idx",
    ]);
  });
});
