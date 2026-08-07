import { describe, expect, it } from "vitest";
import {
  type ImmutableCastKind,
  immutableCastFunction,
  MAGPIE_PREFIX,
  makeNames,
} from "../src/naming.js";

describe("MAGPIE_PREFIX", () => {
  it("is the fixed magpie_ prefix", () => {
    expect(MAGPIE_PREFIX).toBe("magpie_");
  });
});

describe("makeNames", () => {
  it("resolves document tables as <schema>.magpie_doc_<alias>", () => {
    const names = makeNames("public");
    expect(names.documentTable("account")).toBe("public.magpie_doc_account");
  });

  it("moves every object when the schema knob changes", () => {
    const names = makeNames("magpie");
    expect(names.documentTable("account")).toBe("magpie.magpie_doc_account");
    expect(names.eventsTable()).toBe("magpie.magpie_events");
    expect(names.streamsTable()).toBe("magpie.magpie_streams");
    expect(names.eventsSequence()).toBe("magpie.magpie_events_sequence");
    expect(names.quickAppendEvents()).toBe("magpie.magpie_quick_append_events");
  });

  it("exposes the schema for CREATE SCHEMA", () => {
    expect(makeNames("public").schema).toBe("public");
    expect(makeNames("magpie").schema).toBe("magpie");
  });

  it("derives immutable cast wrappers from the kind", () => {
    const names = makeNames("public");
    expect(names.immutableCast("timestamptz")).toBe("public.magpie_immutable_timestamptz");
    expect(names.immutableCast("timestamp")).toBe("public.magpie_immutable_timestamp");
    expect(names.immutableCast("date")).toBe("public.magpie_immutable_date");
  });

  it("keeps the prefix fixed regardless of schema", () => {
    for (const schema of ["public", "magpie", "tenant_a"]) {
      const names = makeNames(schema);
      expect(names.documentTable("account")).toBe(`${schema}.${MAGPIE_PREFIX}doc_account`);
      expect(names.eventsTable()).toBe(`${schema}.${MAGPIE_PREFIX}events`);
    }
  });
});

describe("immutableCastFunction", () => {
  it("names the wrapper for each supported kind", () => {
    const kinds: readonly ImmutableCastKind[] = ["timestamptz", "timestamp", "date"];
    for (const kind of kinds) {
      expect(immutableCastFunction(kind)).toBe(`magpie_immutable_${kind}`);
    }
  });
});
