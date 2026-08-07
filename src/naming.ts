/** Fixed prefix for every Postgres object magpie owns; not configurable. */
export const MAGPIE_PREFIX = "magpie_";

const EVENTS_TABLE = "magpie_events";
const STREAMS_TABLE = "magpie_streams";
const EVENTS_SEQUENCE = "magpie_events_sequence";
const QUICK_APPEND_EVENTS = "magpie_quick_append_events";

export const IMMUTABLE_CAST_KINDS = ["timestamptz", "timestamp", "date"] as const;
export type ImmutableCastKind = (typeof IMMUTABLE_CAST_KINDS)[number];

export function immutableCastFunction(kind: ImmutableCastKind): string {
  return `magpie_immutable_${kind}`;
}

/**
 * Schema-qualified names for every Postgres object magpie owns, resolved from
 * the single configurable schema name. Names are raw identifiers;
 * quote them with postgres-js `sql(name)`, where the dot becomes schema
 * qualification.
 */
export interface MagpieNames {
  readonly schema: string;
  /** The per-document-type table, `magpie_doc_<alias>`. */
  documentTable(alias: string): string;
  /** Global event rows, `magpie_events`. */
  eventsTable(): string;
  /** Per-stream write state, `magpie_streams`. */
  streamsTable(): string;
  /** Global event id sequence, `magpie_events_sequence`. */
  eventsSequence(): string;
  /** Server-side append guard function, `magpie_quick_append_events`. */
  quickAppendEvents(): string;
  /** Immutable jsonb cast wrapper for one target type, `magpie_immutable_<kind>`. */
  immutableCast(kind: ImmutableCastKind): string;
}

export function makeNames(schema: string): MagpieNames {
  return {
    schema,
    documentTable: (alias) => `${schema}.${MAGPIE_PREFIX}doc_${alias}`,
    eventsTable: () => `${schema}.${EVENTS_TABLE}`,
    streamsTable: () => `${schema}.${STREAMS_TABLE}`,
    eventsSequence: () => `${schema}.${EVENTS_SEQUENCE}`,
    quickAppendEvents: () => `${schema}.${QUICK_APPEND_EVENTS}`,
    immutableCast: (kind) => `${schema}.${immutableCastFunction(kind)}`,
  };
}
