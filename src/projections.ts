import type { JSONValue, TransactionSql } from "postgres";
import { deserializeEvent } from "./events.js";
import type { MagpieNames } from "./naming.js";
import type { EventRegistration, InlineProjection, UpcasterRegistration } from "./registry.js";

/** The registrations and naming the inline projection write path needs. */
export interface ProjectionContext {
  readonly names: MagpieNames;
  readonly eventShapes: ReadonlyMap<string, EventRegistration>;
  readonly upcasters: ReadonlyMap<string, UpcasterRegistration>;
  readonly inlineProjections: ReadonlyMap<string, readonly InlineProjection[]>;
}

interface StreamVersionRow {
  readonly version: string;
  readonly type: string | null;
}

interface SnapshotRow {
  readonly data: unknown;
  readonly version: string;
}

interface EventRow {
  readonly type: string;
  readonly data: unknown;
  readonly version: string;
}

/** Transaction handle whose parameters admit bigints; postgres-js serializes them as int8. */
type ProjectionTx = TransactionSql<{ int8: bigint }>;

/**
 * Brings every inline projection up to date for the given streams, inside the session's
 * transaction. Each snapshot is folded from the events appended since the snapshot's
 * version, then written back with the stream's current version; a missing snapshot
 * rebuilds from the full history. Streams whose snapshot is already current — for
 * example after a nested session rolled back — are left untouched.
 */
export async function applyInlineProjections(
  tx: ProjectionTx,
  context: ProjectionContext,
  streamIds: ReadonlySet<string>,
): Promise<void> {
  for (const streamId of streamIds) {
    const streamsTable = tx(context.names.streamsTable());
    const rows = (await tx`
      select version, type from ${streamsTable} where id = ${streamId}
    `) as StreamVersionRow[];
    const stream = rows[0];
    if (stream === undefined) {
      // The stream's appends rolled back with the transaction; nothing to project.
      continue;
    }
    const projections =
      stream.type === null ? undefined : context.inlineProjections.get(stream.type);
    if (projections === undefined || projections.length === 0) {
      continue;
    }
    const streamVersion = BigInt(stream.version);
    for (const projection of projections) {
      await applyOne(tx, context, projection, streamId, streamVersion);
    }
  }
}

async function applyOne(
  tx: ProjectionTx,
  context: ProjectionContext,
  projection: InlineProjection,
  streamId: string,
  streamVersion: bigint,
): Promise<void> {
  const table = tx(context.names.documentTable(projection.alias));
  const snapshotRows = (await tx`
    select data, version from ${table} where id = ${streamId}
  `) as SnapshotRow[];
  const snapshot = snapshotRows[0];
  const snapshotVersion = snapshot === undefined ? 0n : BigInt(snapshot.version);
  if (snapshotVersion === streamVersion) {
    return;
  }
  const eventsTable = tx(context.names.eventsTable());
  const rows = (await tx`
    select type, data, version from ${eventsTable}
    where stream_id = ${streamId} and version > ${snapshotVersion}
    order by version asc
  `) as EventRow[];
  let state = snapshot?.data;
  for (const row of rows) {
    const event = await deserializeEvent(context, row);
    state = projection.fold(state, event);
  }
  await tx`
    insert into ${table} (id, version, data)
    values (${streamId}, ${streamVersion}, ${tx.json(state as JSONValue)})
    on conflict (id) do update
    set version = ${streamVersion},
        data = excluded.data,
        last_modified = now(),
        deleted = false,
        deleted_at = null
  `;
}
