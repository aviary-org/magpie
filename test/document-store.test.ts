import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConcurrencyError, createStore, type Store } from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "./helpers/test-db.js";

interface Account {
  id: string;
  balance: number;
}

interface Profile {
  id: string;
  nickname: string;
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

const profileSchema = schema<Profile>("profile", (value) => {
  const profile = value as Partial<Profile> | null;
  return typeof profile?.id === "string" && typeof profile?.nickname === "string";
});

const account = (id: string, balance: number): Account => ({ id, balance });
const profile = (id: string, nickname: string): Profile => ({ id, nickname });

let db: TestDatabase;
let store: Store;

beforeAll(async () => {
  db = await createTestDatabase({ onnotice: () => {} });
  store = createStore({ sql: db.sql });
  store.document(accountSchema, (t) => ({
    fields: [t.path.id.cast("text").primaryKey()],
  }));
  store.document(profileSchema, (t) => ({
    fields: [t.path.id.cast("text").primaryKey()],
  }));
  await store.migrate();
});

afterAll(async () => {
  await db.teardown();
});

describe("document load", () => {
  it("loads a saved document with its version", async () => {
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("acct-1", 10));
    });

    await store.session(async (s) => {
      const loaded = await s.documents.load(accountSchema, "acct-1");
      expect(loaded?.data).toEqual(account("acct-1", 10));
      expect(loaded?.version).toBe(1n);
    });
  });

  it("loads through the store without a session", async () => {
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("acct-2", 20));
    });

    const loaded = await store.load(accountSchema, "acct-2");
    expect(loaded?.data).toEqual(account("acct-2", 20));
    expect(loaded?.version).toBe(1n);
  });

  it("returns nothing for a missing id", async () => {
    await store.session(async (s) => {
      expect(await s.documents.load(accountSchema, "acct-nope")).toBeUndefined();
    });
    expect(await store.load(accountSchema, "acct-nope")).toBeUndefined();
  });

  it("hands the loaded version back to save, advancing it", async () => {
    await store.session(async (s) => {
      const loaded = await s.documents.load(accountSchema, "acct-1");
      if (loaded === undefined) {
        throw new Error("expected acct-1 to exist");
      }
      await s.documents.save(accountSchema, account("acct-1", 11), {
        expectedVersion: loaded.version,
      });
    });

    const loaded = await store.load(accountSchema, "acct-1");
    expect(loaded?.data).toEqual(account("acct-1", 11));
    expect(loaded?.version).toBe(2n);
  });

  it("rejects a load with a mismatched expected version", async () => {
    await expect(store.load(accountSchema, "acct-1", 99n)).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it("accepts a load with the matching expected version", async () => {
    const loaded = await store.load(accountSchema, "acct-1", 2n);
    expect(loaded?.data).toEqual(account("acct-1", 11));
  });

  it("rejects loads of unregistered schemas", async () => {
    const ghostSchema = schema<Account>("ghost_account", () => true);
    await expect(store.load(ghostSchema, "acct-1")).rejects.toThrow(/not registered/);
  });

  it("keeps documents of different types with the same id separate", async () => {
    await store.session(async (s) => {
      await s.documents.save(profileSchema, profile("shared-id", "nix"));
    });

    const accountRow = await store.load(accountSchema, "shared-id");
    const profileRow = await store.load(profileSchema, "shared-id");
    expect(accountRow).toBeUndefined();
    expect(profileRow?.data).toEqual(profile("shared-id", "nix"));
  });
});

describe("document delete", () => {
  it("soft delete hides the document from loads", async () => {
    await store.session(async (s) => {
      await s.documents.delete(accountSchema, "acct-2");
    });

    expect(await store.load(accountSchema, "acct-2")).toBeUndefined();
  });

  it("soft delete keeps the row and its version", async () => {
    const rows =
      await db.sql`select version, deleted, deleted_at from public.magpie_doc_account where id = 'acct-2'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe("1");
    expect(rows[0]?.deleted).toBe(true);
    expect(rows[0]?.deleted_at).not.toBeNull();
  });

  it("saving with the pre-delete version resurrects a soft-deleted document", async () => {
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("acct-4", 25));
      await s.documents.delete(accountSchema, "acct-4");
      // Soft delete does not advance the version, so the pre-delete version still admits the save.
      await s.documents.save(accountSchema, account("acct-4", 26), { expectedVersion: 1n });
    });

    const loaded = await store.load(accountSchema, "acct-4");
    expect(loaded?.data).toEqual(account("acct-4", 26));
    expect(loaded?.version).toBe(2n);
  });

  it("hard delete removes the row entirely", async () => {
    await store.session(async (s) => {
      await s.documents.delete(accountSchema, "acct-1", { hard: true });
    });

    expect(await store.load(accountSchema, "acct-1")).toBeUndefined();
    const rows = await db.sql`select id from public.magpie_doc_account where id = 'acct-1'`;
    expect(rows).toHaveLength(0);
  });

  it("hard delete also removes a soft-deleted row", async () => {
    await store.session(async (s) => {
      await s.documents.delete(accountSchema, "acct-2", { hard: true });
    });

    const rows = await db.sql`select id from public.magpie_doc_account where id = 'acct-2'`;
    expect(rows).toHaveLength(0);
  });

  it("deleting a missing document is a no-op", async () => {
    await expect(
      store.session(async (s) => {
        await s.documents.delete(accountSchema, "acct-ghost");
      }),
    ).resolves.toBeUndefined();
  });

  it("a load after queued writes in one session sees them", async () => {
    await store.session(async (s) => {
      await s.documents.save(accountSchema, account("acct-3", 5));
      const loaded = await s.documents.load(accountSchema, "acct-3");
      expect(loaded?.data).toEqual(account("acct-3", 5));
      expect(loaded?.version).toBe(1n);
      await s.documents.delete(accountSchema, "acct-3");
      expect(await s.documents.load(accountSchema, "acct-3")).toBeUndefined();
    });
  });
});
