import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import {
  dataExtraction,
  documentTableStatements,
  duplicatedColumn,
  duplicatedColumnName,
  eventStorageStatements,
  immutableCastStatements,
  migrationStatements,
} from "../src/ddl.js";
import type { FieldSpec } from "../src/document.js";
import { makeNames } from "../src/naming.js";
import type { DocumentRegistration } from "../src/registry.js";

const names = makeNames("public");

const testSchema: StandardSchemaV1 = {
  "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
};

function spec(path: readonly string[], overrides: Partial<FieldSpec> = {}): FieldSpec {
  return {
    path,
    cast: undefined,
    isPrimaryKey: false,
    isIndexed: false,
    hasContainsIndex: false,
    ...overrides,
  };
}

describe("duplicatedColumnName", () => {
  it("prefixes the joined path with f_", () => {
    expect(duplicatedColumnName(["balance"])).toBe("f_balance");
    expect(duplicatedColumnName(["address", "city"])).toBe("f_address_city");
  });

  it("rejects segments that cannot be identifiers", () => {
    expect(() => duplicatedColumnName(["my-field"])).toThrow(/cannot be indexed/);
  });
});

describe("duplicatedColumn", () => {
  it("defaults an uncast field to plain text extraction", () => {
    expect(duplicatedColumn(spec(["name"], { isIndexed: true }), names)).toEqual({
      name: "f_name",
      type: "text",
      expression: "data #>> '{\"name\"}'",
    });
  });

  it("uses the immutable wrapper for date-like casts", () => {
    const column = duplicatedColumn(
      spec(["updatedAt"], { cast: "timestamptz", isIndexed: true }),
      names,
    );
    expect(column.type).toBe("timestamptz");
    expect(column.expression).toBe(
      '"public"."magpie_immutable_timestamptz"(data #>> \'{"updatedAt"}\')',
    );
  });

  it("casts with :: for other types", () => {
    const column = duplicatedColumn(spec(["balance"], { cast: "numeric", isIndexed: true }), names);
    expect(column.expression).toBe("(data #>> '{\"balance\"}')::numeric");
  });

  it("extracts nested paths with a path literal", () => {
    const column = duplicatedColumn(
      spec(["address", "city"], { cast: "uuid", isIndexed: true }),
      names,
    );
    expect(column.name).toBe("f_address_city");
    expect(column.expression).toBe('(data #>> \'{"address","city"}\')::uuid');
  });
});

describe("dataExtraction", () => {
  it("escapes quotes in path segments", () => {
    expect(dataExtraction(["a'b", 'c"d'])).toBe(`data #>> '{"a''b","c\\"d"}'`);
  });
});

describe("documentTableStatements", () => {
  const account: DocumentRegistration = {
    schema: testSchema,
    alias: "account",
    idField: "id",
    fields: [
      spec(["id"], { cast: "uuid", isPrimaryKey: true }),
      spec(["balance"], { cast: "numeric", isIndexed: true }),
      spec(["updatedAt"], { cast: "timestamptz", isIndexed: true }),
      spec(["name"], { isIndexed: true }),
      spec(["tags"], { hasContainsIndex: true }),
    ],
  };

  it("creates the table with base and duplicated columns", () => {
    const [create] = documentTableStatements(names, account);
    expect(create).toContain('CREATE TABLE IF NOT EXISTS "public"."magpie_doc_account"');
    expect(create).toContain("id uuid PRIMARY KEY");
    expect(create).toContain("version bigint NOT NULL");
    expect(create).toContain("data jsonb NOT NULL");
    expect(create).toContain("last_modified timestamptz NOT NULL DEFAULT now()");
    expect(create).toContain("deleted boolean NOT NULL DEFAULT false");
    expect(create).toContain("deleted_at timestamptz");
    expect(create).toContain(
      '"f_balance" numeric GENERATED ALWAYS AS ((data #>> \'{"balance"}\')::numeric) STORED',
    );
    expect(create).toContain(
      '"f_updatedAt" timestamptz GENERATED ALWAYS AS ("public"."magpie_immutable_timestamptz"(data #>> \'{"updatedAt"}\')) STORED',
    );
  });

  it("adds drift-safe ALTER statements for pre-existing tables", () => {
    const statements = documentTableStatements(names, account);
    expect(statements[1]).toContain("ALTER TABLE");
    expect(statements[1]).toContain("ADD COLUMN IF NOT EXISTS");
    expect(statements[1]).toContain('"f_balance"');
  });

  it("indexes duplicated columns and the GIN containment index", () => {
    const statements = documentTableStatements(names, account);
    expect(statements).toContain(
      'CREATE INDEX IF NOT EXISTS "magpie_doc_account_f_balance_idx" ON "public"."magpie_doc_account" ("f_balance")',
    );
    expect(statements).toContain(
      'CREATE INDEX IF NOT EXISTS "magpie_doc_account_data_gin" ON "public"."magpie_doc_account" USING gin (data jsonb_path_ops)',
    );
  });

  it("does not duplicate the id column when the id field is indexed", () => {
    const registration: DocumentRegistration = {
      ...account,
      fields: [spec(["id"], { cast: "uuid", isPrimaryKey: true, isIndexed: true })],
    };
    const [create] = documentTableStatements(names, registration);
    expect(create).not.toContain("f_id");
  });

  it("defaults the id column to text without an id cast", () => {
    const registration: DocumentRegistration = {
      ...account,
      idField: "id",
      fields: [spec(["name"], { isIndexed: true })],
    };
    const [create] = documentTableStatements(names, registration);
    expect(create).toContain("id text PRIMARY KEY");
  });

  it("rejects fields that collide on the same duplicated column", () => {
    const registration: DocumentRegistration = {
      ...account,
      fields: [spec(["a_b"], { isIndexed: true }), spec(["a", "b"], { isIndexed: true })],
    };
    expect(() => documentTableStatements(names, registration)).toThrow(/same duplicated column/);
  });
});

describe("eventStorageStatements", () => {
  it("creates the sequence, event table, unique index, and stream table", () => {
    const statements = eventStorageStatements(names);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toBe('CREATE SEQUENCE IF NOT EXISTS "public"."magpie_events_sequence"');
    expect(statements[1]).toContain('CREATE TABLE IF NOT EXISTS "public"."magpie_events"');
    expect(statements[1]).toContain(
      "id bigint PRIMARY KEY DEFAULT nextval('public.magpie_events_sequence')",
    );
    expect(statements[1]).toContain("stream_id text NOT NULL");
    expect(statements[1]).toContain("version bigint NOT NULL");
    expect(statements[1]).toContain("type text NOT NULL");
    expect(statements[1]).toContain("data jsonb NOT NULL");
    expect(statements[1]).toContain("timestamp timestamptz NOT NULL DEFAULT now()");
    expect(statements[2]).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS magpie_events_stream_version_idx",
    );
    expect(statements[2]).toContain("(stream_id, version)");
    expect(statements[3]).toContain('CREATE TABLE IF NOT EXISTS "public"."magpie_streams"');
  });
});

describe("immutableCastStatements", () => {
  it("creates the three wrapper functions", () => {
    const statements = immutableCastStatements(names);
    expect(statements).toHaveLength(3);
    for (const kind of ["timestamptz", "timestamp", "date"]) {
      expect(statements).toContain(
        `CREATE OR REPLACE FUNCTION "public"."magpie_immutable_${kind}"(text) RETURNS ${kind} LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT $1::${kind} $$`,
      );
    }
  });
});

describe("migrationStatements", () => {
  it("orders functions before tables in the default schema", () => {
    const statements = migrationStatements(names, [
      {
        schema: testSchema,
        alias: "account",
        idField: "id",
        fields: [spec(["balance"], { cast: "numeric", isIndexed: true })],
      },
    ]);
    const functions = statements.findIndex((s) => s.includes("magpie_immutable_timestamptz"));
    const table = statements.findIndex((s) => s.includes("magpie_doc_account"));
    const events = statements.findIndex((s) => s.includes("magpie_events"));
    expect(functions).toBeGreaterThanOrEqual(0);
    expect(functions).toBeLessThan(events);
    expect(events).toBeLessThan(table);
  });

  it("creates a custom schema before anything else", () => {
    const statements = migrationStatements(makeNames("magpie"), []);
    expect(statements[0]).toBe('CREATE SCHEMA IF NOT EXISTS "magpie"');
  });

  it("skips CREATE SCHEMA for public", () => {
    const statements = migrationStatements(names, []);
    expect(statements.some((s) => s.includes("CREATE SCHEMA"))).toBe(false);
  });
});
