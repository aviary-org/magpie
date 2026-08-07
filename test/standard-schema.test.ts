import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, expectTypeOf, it } from "vitest";
import { isStandardSchema, validateWith, type SchemaOutput } from "../src/index.js";

interface Account {
  id: string;
  balance: number;
}

const accountSchema: StandardSchemaV1<unknown, Account> = {
  "~standard": {
    version: 1,
    vendor: "test",
    types: { input: {} as Account, output: {} as Account },
    validate: (value: unknown) => {
      const account = value as Account;
      if (typeof account.balance !== "number") {
        return { issues: [{ message: "balance must be a number" }] };
      }
      return { value: account };
    },
  },
};

const asyncSchema: StandardSchemaV1<unknown, { readonly n: number }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    types: { input: {} as { readonly n: number }, output: {} as { readonly n: number } },
    validate: async (value: unknown) => ({ value: value as { readonly n: number } }),
  },
};

describe("validateWith", () => {
  it("returns the typed value on success", async () => {
    const result = await validateWith(accountSchema, { id: "a", balance: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ id: "a", balance: 1 });
      expectTypeOf(result.value).toEqualTypeOf<Account>();
    }
  });

  it("returns issues on failure", async () => {
    const result = await validateWith(accountSchema, { id: "a", balance: "lots" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([{ message: "balance must be a number" }]);
    }
  });

  it("handles async validators", async () => {
    const result = await validateWith(asyncSchema, { n: 1 });
    expect(result.ok).toBe(true);
  });

  it("extracts the output type from ~standard.types.output", () => {
    type Output = SchemaOutput<typeof accountSchema>;
    expectTypeOf<Output>().toEqualTypeOf<Account>();
  });
});

describe("isStandardSchema", () => {
  it("accepts a conforming schema", () => {
    expect(isStandardSchema(accountSchema)).toBe(true);
  });

  it("rejects non-schema values", () => {
    expect(isStandardSchema(null)).toBe(false);
    expect(isStandardSchema({})).toBe(false);
    expect(isStandardSchema({ "~standard": { version: 2, validate: () => ({}) } })).toBe(false);
    expect(isStandardSchema({ "~standard": { version: 1 } })).toBe(false);
  });
});
