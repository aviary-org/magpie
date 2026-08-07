import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStore, type Store } from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "./helpers/test-db.js";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ onnotice: () => {} });
});

afterAll(async () => {
  await db.teardown();
});

interface Account {
  id: string;
  balance: number;
  name: string;
  updatedAt: Date;
  tags: string[];
  email?: string;
}

const accountSchema: StandardSchemaV1<unknown, Account> & { readonly name: string } = {
  name: "account",
  "~standard": {
    version: 1,
    vendor: "test",
    types: { input: {} as Account, output: {} as Account },
    validate: (value: unknown) => ({ value: value as Account }),
  },
};

interface AuditEntry {
  id: string;
  at: Date;
}

const auditSchema: StandardSchemaV1<unknown, AuditEntry> & { readonly name: string } = {
  name: "audit",
  "~standard": {
    version: 1,
    vendor: "test",
    types: { input: {} as AuditEntry, output: {} as AuditEntry },
    validate: (value: unknown) => ({ value: value as AuditEntry }),
  },
};

interface Invoice {
  id: string;
  total: number;
}

const invoiceSchema: StandardSchemaV1<unknown, Invoice> & { readonly name: string } = {
  name: "invoice",
  "~standard": {
    version: 1,
    vendor: "test",
    types: { input: {} as Invoice, output: {} as Invoice },
    validate: (value: unknown) => ({ value: value as Invoice }),
  },
};

function makeStore(options: { schema?: string; autoCreate?: boolean } = {}): Store {
  const store = createStore({ sql: db.sql, ...options });
  store.document(accountSchema, (t) => ({
    fields: [
      t.path.balance.cast("numeric").index(),
      t.path.name.index(),
      t.path.updatedAt.cast("timestamptz").index(),
      t.path.tags.containsIndex(),
    ],
  }));
  return store;
}

function registered(table: string): Promise<boolean> {
  return db.sql`select to_regclass(${table}) as t`.then((rows) => rows[0]?.t !== null);
}

describe("store.migrate", () => {
  it("creates every registered object", async () => {
    const store = makeStore();
    await store.migrate();

    for (const object of [
      "public.magpie_doc_account",
      "public.magpie_events",
      "public.magpie_streams",
      "public.magpie_events_sequence",
    ]) {
      expect(await registered(object)).toBe(true);
    }

    const functions = await db.sql`
      select count(*)::int as n
      from pg_proc
      where proname in ('magpie_immutable_timestamptz', 'magpie_immutable_timestamp', 'magpie_immutable_date')
        and pronamespace = 'public'::regnamespace
    `;
    expect(functions[0]?.n).toBe(3);

    const indexes = await db.sql`
      select indexname
      from pg_indexes
      where tablename = 'magpie_doc_account'
    `;
    const names = indexes.map((row) => row.indexname).sort();
    expect(names).toEqual(
      [
        "magpie_doc_account_data_gin",
        "magpie_doc_account_f_balance_idx",
        "magpie_doc_account_f_name_idx",
        "magpie_doc_account_f_updatedAt_idx",
        "magpie_doc_account_pkey",
      ].sort(),
    );
  });

  it("is idempotent", async () => {
    const store = makeStore();
    await store.migrate();
    const before = await db.sql`
      select count(*)::int as n
      from pg_class
      where relname like 'magpie\_%' escape '\\'
    `;
    await store.migrate();
    const after = await db.sql`
      select count(*)::int as n
      from pg_class
      where relname like 'magpie\_%' escape '\\'
    `;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("materializes duplicated columns through generated expressions", async () => {
    const store = makeStore();
    await store.migrate();

    await db.sql`
      insert into public.magpie_doc_account (id, version, data)
      values (
        'acct-1',
        1,
        '{"id": "acct-1", "balance": 100.5, "name": "Acme", "updatedAt": "2024-01-02T03:04:05Z", "tags": ["a", "b"]}'
      )
    `;

    const rows = await db.sql`
      select f_balance, f_name, "f_updatedAt"
      from public.magpie_doc_account
      where id = 'acct-1'
    `;
    const row = rows[0];
    expect(row?.f_balance).toBe("100.5");
    expect(row?.f_name).toBe("Acme");
    expect(new Date(row?.f_updatedAt as string).toISOString()).toBe("2024-01-02T03:04:05.000Z");
  });

  it("migrates into a custom schema, including indexes", async () => {
    const store = createStore({ sql: db.sql, schema: "magpie" });
    store.document(auditSchema, (t) => ({
      fields: [t.path.at.cast("timestamptz").index()],
    }));
    await store.migrate();

    expect(await registered("magpie.magpie_doc_audit")).toBe(true);
    expect(await registered("public.magpie_doc_audit")).toBe(false);

    const indexes = await db.sql`
      select schemaname
      from pg_indexes
      where indexname = 'magpie_doc_audit_f_at_idx'
    `;
    expect(indexes[0]?.schemaname).toBe("magpie");
  });

  it("adds duplicated columns for fields indexed after the first migrate", async () => {
    const first = makeStore();
    await first.migrate();

    await db.sql`
      insert into public.magpie_doc_account (id, version, data)
      values ('acct-2', 1, '{"id": "acct-2", "balance": 1}')
    `;

    const second = createStore({ sql: db.sql });
    second.document(accountSchema, (t) => ({
      fields: [
        t.path.balance.cast("numeric").index(),
        t.path.name.index(),
        t.path.updatedAt.cast("timestamptz").index(),
        t.path.tags.containsIndex(),
        t.path.email.index(),
      ],
    }));
    await second.migrate();

    const columns = await db.sql`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'magpie_doc_account'
    `;
    expect(columns.map((row) => row.column_name)).toContain("f_email");

    const rows = await db.sql`
      select f_email
      from public.magpie_doc_account
      where id = 'acct-2'
    `;
    expect(rows[0]?.f_email).toBeNull();
  });

  it("rolls back the whole migrate when one statement fails", async () => {
    const store = createStore({ sql: db.sql, schema: "rollback_probe" });
    store.document(accountSchema, (t) => ({
      fields: [t.path.balance.cast("not_a_pg_type").index()],
    }));
    await expect(store.migrate()).rejects.toThrow();

    expect(await registered("rollback_probe.magpie_doc_account")).toBe(false);
    const schemas = await db.sql`select 1 from pg_namespace where nspname = 'rollback_probe'`;
    expect(schemas.length).toBe(0);
  });

  it("autoCreate memoizes until a new document type is registered", async () => {
    const store = createStore({ sql: db.sql, autoCreate: true });
    store.document(accountSchema, (t) => ({
      fields: [t.path.balance.cast("numeric").index()],
    }));
    await store.migrate();
    expect(await registered("public.magpie_doc_account")).toBe(true);

    store.document(invoiceSchema, (t) => ({ fields: [t.path.total.cast("numeric").index()] }));
    await store.migrate();
    expect(await registered("public.magpie_doc_invoice")).toBe(true);
  });
});
