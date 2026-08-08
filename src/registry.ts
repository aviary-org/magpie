import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FieldSpec } from "./document.js";

/** A registered document type. */
export interface DocumentRegistration {
  readonly schema: StandardSchemaV1;
  readonly alias: string;
  readonly idField: string;
  readonly fields: readonly FieldSpec[];
}

/** A registered event shape, keyed by its stored (versioned) name. */
export interface EventRegistration {
  readonly schema: StandardSchemaV1;
}

/** The write-time contract of a stream: which stored event names may be appended. */
export interface StreamContract {
  readonly events: readonly string[];
}

export interface StreamRegistration {
  readonly contract: StreamContract;
}

/** Read-time transform from an old stored event shape to the current shape. */
export type UpcasterFn = (old: unknown) => unknown;

export interface UpcasterRegistration {
  readonly upcast: UpcasterFn;
}

/** One fold step: fold an event into the aggregate state. */
export type FoldFn = (state: unknown, event: unknown) => unknown;

/** A registered aggregate: a stream's events folded into a shape. */
export interface AggregateRegistration {
  readonly streamName: string;
  readonly schema: StandardSchemaV1;
  readonly fold: FoldFn;
  /** Persist the fold output into the aggregate's document table on every append. */
  readonly inline: boolean;
}

/** The inline lifecycle of a fold: the output persisted as snapshot rows. */
export interface InlineProjection {
  /** The document table alias the snapshot rows live in. */
  readonly alias: string;
  readonly fold: FoldFn;
}
