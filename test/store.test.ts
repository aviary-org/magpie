import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { createStore, type Store, type StoreOptions } from "../src/index.js";

const fakeSql = {} as unknown as Sql;

function makeStore(options: Partial<StoreOptions> = {}): Store {
  return createStore({ sql: fakeSql, ...options });
}

interface Account {
  id: string;
  balance: number;
}

const accountSchema: StandardSchemaV1<unknown, Account> & { readonly name: string } = {
  name: "accounts",
  "~standard": {
    version: 1,
    vendor: "test",
    types: { input: {} as Account, output: {} as Account },
    validate: (value: unknown) => ({ value: value as Account }),
  },
};

const plainSchema: StandardSchemaV1 = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
};

describe("createStore", () => {
  it("throws without a sql instance", () => {
    expect(() => createStore(undefined as unknown as StoreOptions)).toThrow(/sql/);
    expect(() => createStore({} as unknown as StoreOptions)).toThrow(/sql/);
  });

  it("throws on an invalid schema name", () => {
    expect(() => makeStore({ schema: "Bad-Name!" })).toThrow(/schema/);
  });

  it("throws on a non-boolean autoCreate", () => {
    expect(() => makeStore({ autoCreate: "yes" as unknown as boolean })).toThrow(/autoCreate/);
  });

  it("accepts the documented defaults", () => {
    expect(() => makeStore()).not.toThrow();
  });

  it("exposes the registration surface", () => {
    const store = makeStore();
    for (const method of ["document", "event", "stream", "upcaster", "aggregate", "session"]) {
      expect(typeof (store as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  });

  it("accepts registrations", () => {
    const store = makeStore();
    expect(() => {
      store.document(accountSchema, (t) => ({
        fields: [t.path.id.cast("uuid").primaryKey()],
      }));
      store.event("order_placed", plainSchema);
      store.stream("order", { events: ["order_placed"] });
      store.upcaster("order_placed_v1", (old) => old);
      store.aggregate("order", plainSchema, (state) => state);
    }).not.toThrow();
  });
});

describe("registration validation", () => {
  it("rejects duplicate document aliases", () => {
    const store = makeStore();
    store.document(accountSchema);
    expect(() => store.document(accountSchema)).toThrow(/already registered/);
  });

  it("rejects duplicate event names", () => {
    const store = makeStore();
    store.event("order_placed", plainSchema);
    expect(() => store.event("order_placed", plainSchema)).toThrow(/already registered/);
  });

  it("rejects duplicate stream names", () => {
    const store = makeStore();
    store.event("order_placed", plainSchema);
    store.stream("order", { events: ["order_placed"] });
    expect(() => store.stream("order", { events: ["order_placed"] })).toThrow(/already registered/);
  });

  it("rejects duplicate upcasters", () => {
    const store = makeStore();
    store.upcaster("order_placed_v1", (old) => old);
    expect(() => store.upcaster("order_placed_v1", (old) => old)).toThrow(/already registered/);
  });

  it("rejects streams referencing unknown events", () => {
    const store = makeStore();
    expect(() => store.stream("order", { events: ["never_registered"] })).toThrow(/unknown event/);
  });

  it("rejects aggregates referencing unknown streams", () => {
    const store = makeStore();
    expect(() => store.aggregate("order", plainSchema, (state) => state)).toThrow(/unknown stream/);
  });

  it("rejects non-standard schemas", () => {
    const store = makeStore();
    expect(() => store.document({} as StandardSchemaV1)).toThrow(/Standard Schema/);
    expect(() => store.event("order_placed", {} as StandardSchemaV1)).toThrow(/Standard Schema/);
  });

  it("rejects malformed names", () => {
    const store = makeStore();
    expect(() => store.event("Bad Name", plainSchema)).toThrow(/name/);
    expect(() => store.stream("", { events: [] })).toThrow(/name/);
  });

  it("rejects documents without a derivable alias", () => {
    const store = makeStore();
    expect(() => store.document(plainSchema)).toThrow(/alias/);
  });
});
