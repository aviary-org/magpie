import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { makeFieldBuilder, makePathRoot, resolveDocumentConfig } from "../src/document.js";

interface Account {
  id: string;
  balance: number;
  address: { city: string; zip: string };
  createdAt: Date;
  tags: string[];
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

const unnamedSchema: StandardSchemaV1<unknown, Account> = {
  "~standard": {
    version: 1,
    vendor: "test",
    types: { input: {} as Account, output: {} as Account },
    validate: (value: unknown) => ({ value: value as Account }),
  },
};

describe("resolveDocumentConfig", () => {
  it("derives the alias from the schema name by default", () => {
    const resolved = resolveDocumentConfig(accountSchema);
    expect(resolved.alias).toBe("accounts");
    expect(resolved.idField).toBe("id");
    expect(resolved.fields).toEqual([]);
  });

  it("prefers a name from the config", () => {
    const resolved = resolveDocumentConfig(accountSchema, () => ({ name: "accounts_v2" }));
    expect(resolved.alias).toBe("accounts_v2");
  });

  it("rejects a schema with no derivable alias", () => {
    expect(() => resolveDocumentConfig(unnamedSchema)).toThrow(/alias/);
  });

  it("extracts field metadata from the config callback", () => {
    const resolved = resolveDocumentConfig(accountSchema, (t) => ({
      fields: [
        t.path.id.cast("uuid").primaryKey(),
        t.path.balance.cast("numeric").index(),
        t.path.address.city.index(),
        t.path.tags.containsIndex(),
      ],
    }));
    expect(resolved.idField).toBe("id");
    expect(resolved.fields).toEqual([
      { path: ["id"], cast: "uuid", isPrimaryKey: true, isIndexed: false, hasContainsIndex: false },
      { path: ["balance"], cast: "numeric", isPrimaryKey: false, isIndexed: true, hasContainsIndex: false },
      { path: ["address", "city"], cast: undefined, isPrimaryKey: false, isIndexed: true, hasContainsIndex: false },
      { path: ["tags"], cast: undefined, isPrimaryKey: false, isIndexed: false, hasContainsIndex: true },
    ]);
  });

  it("derives the id field from the primary key marker", () => {
    const resolved = resolveDocumentConfig(accountSchema, (t) => ({
      fields: [t.path.address.city.primaryKey()],
    }));
    expect(resolved.idField).toBe("address.city");
  });

  it("rejects more than one primary key field", () => {
    expect(() =>
      resolveDocumentConfig(accountSchema, (t) => ({
        fields: [t.path.id.primaryKey(), t.path.balance.primaryKey()],
      })),
    ).toThrow(/primary key/);
  });
});

describe("field builder chains", () => {
  it("accumulates metadata without mutating earlier builders", () => {
    const base = makeFieldBuilder(["balance"]);
    const spec = base.cast("numeric").index().primaryKey().toSpec();
    expect(spec).toEqual({
      path: ["balance"],
      cast: "numeric",
      isPrimaryKey: true,
      isIndexed: true,
      hasContainsIndex: false,
    });
    expect(base.toSpec()).toEqual({
      path: ["balance"],
      cast: undefined,
      isPrimaryKey: false,
      isIndexed: false,
      hasContainsIndex: false,
    });
  });
});

describe("path root traversal", () => {
  it("walks nested fields through a proxy", () => {
    const root = makePathRoot<Account>();
    expect(root.path.balance.path).toEqual(["balance"]);
    expect(root.path.address.city.path).toEqual(["address", "city"]);
    expect(root.path.address.zip.path).toEqual(["address", "zip"]);
  });

  it("keeps the leaf metadata reachable at any depth", () => {
    const root = makePathRoot<Account>();
    expect(root.path.address.city.cast("text").toSpec()).toEqual({
      path: ["address", "city"],
      cast: "text",
      isPrimaryKey: false,
      isIndexed: false,
      hasContainsIndex: false,
    });
  });
});
