import type { ISql } from "postgres";
import { ValidationError } from "./errors.js";
import type { MagpieNames } from "./naming.js";
import type { EventRegistration, FoldFn, UpcasterRegistration } from "./registry.js";
import { validateWith } from "./standard-schema.js";

/** One event after deserialization: data is upcast when an upcaster applies, otherwise as stored. */
export interface StoredEvent {
  readonly type: string;
  readonly data: unknown;
  readonly version: bigint;
}

/** The registrations and naming the event read path needs. */
export interface EventReadContext {
  readonly names: MagpieNames;
  readonly eventShapes: ReadonlyMap<string, EventRegistration>;
  readonly upcasters: ReadonlyMap<string, UpcasterRegistration>;
}

interface EventRow {
  readonly type: string;
  readonly data: unknown;
  readonly version: string;
}

/**
 * Runs one stored row through the deserialization chokepoint shared by reads, folds, and
 * validation. An upcaster keyed by the stored name runs first when registered, and its output
 * is validated against the shape registered under that stored name — the current shape. Rows
 * without an upcaster are returned as stored: ingestion already validated them, and reads
 * never re-validate.
 */
export async function deserializeEvent(
  context: EventReadContext,
  row: EventRow,
): Promise<StoredEvent> {
  const upcaster = context.upcasters.get(row.type);
  let data = row.data;
  if (upcaster !== undefined) {
    data = upcaster.upcast(row.data);
    const shape = context.eventShapes.get(row.type);
    if (shape !== undefined) {
      const result = await validateWith(shape.schema, data);
      if (!result.ok) {
        throw new ValidationError(
          `upcaster for event "${row.type}" produced data that fails validation`,
          result.issues,
        );
      }
      data = result.value;
    }
  }
  return { type: row.type, data, version: BigInt(row.version) };
}

/** Reads a stream's event history in version order; `fromVersion` starts the slice there. */
export async function readStreamHistory(
  sql: ISql<{ int8: bigint }>,
  context: EventReadContext,
  streamId: string,
  fromVersion?: bigint,
): Promise<readonly StoredEvent[]> {
  const table = sql(context.names.eventsTable());
  const rows = (
    fromVersion === undefined
      ? await sql`select type, data, version from ${table} where stream_id = ${streamId} order by version asc`
      : await sql`select type, data, version from ${table} where stream_id = ${streamId} and version >= ${fromVersion} order by version asc`
  ) as EventRow[];
  return Promise.all(rows.map((row) => deserializeEvent(context, row)));
}

/** Folds a stream's events with a registered fold; nothing when the stream has no events. */
export async function foldStream(
  sql: ISql<{ int8: bigint }>,
  context: EventReadContext,
  fold: FoldFn,
  streamId: string,
): Promise<unknown> {
  const events = await readStreamHistory(sql, context, streamId);
  return events.reduce<unknown>((state, event) => fold(state, event), undefined);
}
