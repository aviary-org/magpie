import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ISql, JSONValue, Sql, TransactionSql } from "postgres";
import { ConcurrencyError, RollbackSignal, ValidationError } from "./errors.js";
import type { MagpieNames } from "./naming.js";
import { applyInlineProjections } from "./projections.js";
import type {
  DocumentRegistration,
  EventRegistration,
  InlineProjection,
  StreamRegistration,
  UpcasterRegistration,
} from "./registry.js";
import { type SchemaOutput, validateWith } from "./standard-schema.js";

/** One event to append: its stored (versioned) name and payload. */
export interface AppendEvent {
  readonly type: string;
  readonly data: unknown;
}

/** A document loaded from storage: its data plus the version to hand back on save. */
export interface LoadedDocument<TOutput> {
  /** The stored document payload, parsed from jsonb. */
  readonly data: TOutput;
  /** The stored version; pass it back to save as `expectedVersion` to update. */
  readonly version: bigint;
}

/** The session-scoped document surface. */
export interface SessionDocuments {
  /**
   * Queues a document save, validated against its registered shape before any SQL runs.
   * `expectedVersion` defaults to `0` (must not exist); pass the version read from a
   * loaded document to update it, or `"any"` to write unconditionally.
   */
  save<TSchema extends StandardSchemaV1>(
    schema: TSchema,
    document: SchemaOutput<TSchema>,
    options?: { readonly expectedVersion?: bigint | "any" },
  ): Promise<void>;
  /**
   * Reads a document by id; returns nothing when absent (soft-deleted rows count as
   * absent). An `expectedVersion` guards the read: a mismatch raises a concurrency error.
   */
  load<TSchema extends StandardSchemaV1>(
    schema: TSchema,
    id: string | number | bigint,
    expectedVersion?: bigint,
  ): Promise<LoadedDocument<SchemaOutput<TSchema>> | undefined>;
  /**
   * Deletes a document. Soft delete (the default) flips the `deleted` flags without
   * advancing the version, so a later save resurrects the row; hard delete removes it.
   * Deleting a missing or already-soft-deleted document is a no-op.
   */
  delete<TSchema extends StandardSchemaV1>(
    schema: TSchema,
    id: string | number | bigint,
    options?: { readonly hard?: boolean },
  ): Promise<void>;
}

/** The session-scoped event append surface. */
export interface SessionEvents {
  /**
   * Queues an event append. `expectedVersion: 0` requires the stream to not exist,
   * `expectedVersion: N` requires it at version N; without either the append proceeds
   * regardless, auto-creating a missing stream.
   */
  append(
    streamId: string,
    events: readonly AppendEvent[],
    options?: { readonly expectedVersion?: bigint },
  ): Promise<void>;
}

/** The unit of work: one Postgres transaction spanning document saves and event appends. */
export interface Session {
  readonly documents: SessionDocuments;
  readonly events: SessionEvents;
  /** Opens a nested session on a savepoint; its writes commit with the outer session. */
  session<T>(callback: (session: Session) => Promise<T> | T): Promise<T | undefined>;
  /** Aborts the session; nothing written is persisted and the session resolves with `undefined`. */
  rollback(): never;
}

/** The registrations and naming a session needs to translate writes into SQL. */
export interface SessionContext {
  readonly names: MagpieNames;
  readonly eventShapes: ReadonlyMap<string, EventRegistration>;
  readonly streams: ReadonlyMap<string, StreamRegistration>;
  readonly upcasters: ReadonlyMap<string, UpcasterRegistration>;
  readonly inlineProjections: ReadonlyMap<string, readonly InlineProjection[]>;
  findDocument(schema: StandardSchemaV1): DocumentRegistration | undefined;
}

/** Mutable state shared by a session and its nested sessions. */
interface SessionRunState {
  /** Streams with appends in this session; their projections refresh at commit. */
  readonly pendingStreams: Set<string>;
}

type PendingOperation = () => Promise<void>;

/** A fresh document save; a missing row is the only state the default guard admits. */
const DEFAULT_EXPECTED_VERSION = 0n;

/** Transaction handle whose parameters admit bigints; postgres-js serializes them as int8. */
type SessionTx = TransactionSql<{ int8: bigint }>;

/** Read handle (transaction or store) with the same parameter admission. */
export type StoreReadSql = ISql<{ int8: bigint }>;

interface SaveRow {
  readonly version: string;
  readonly inserted: boolean;
}

interface LoadRow {
  readonly data: unknown;
  readonly version: string;
}

interface StreamRow {
  readonly version: string;
  readonly type: string | null;
}

/** Runs a callback inside one Postgres transaction, committing on return and rolling back on throw. */
export async function runSession<T>(
  sql: Sql,
  context: SessionContext,
  callback: (session: Session) => Promise<T> | T,
): Promise<T | undefined> {
  return (
    sql.begin(async (tx) => {
      const state: SessionRunState = { pendingStreams: new Set() };
      const session = new SessionImpl(tx as unknown as SessionTx, context, state);
      const result = await callback(session);
      await session.flush();
      await applyInlineProjections(tx as unknown as SessionTx, context, state.pendingStreams);
      return result;
    }) as Promise<T>
  ).catch((error: unknown) => {
    if (error instanceof RollbackSignal) {
      return undefined;
    }
    throw error;
  });
}

class SessionImpl implements Session {
  readonly documents: SessionDocuments;
  readonly events: SessionEvents;
  private readonly queue: PendingOperation[] = [];

  constructor(
    private readonly tx: SessionTx,
    private readonly context: SessionContext,
    private readonly state: SessionRunState,
  ) {
    this.documents = {
      save: (schema, document, options) => this.enqueueSave(schema, document, options),
      load: (schema, id, expectedVersion) => this.load(schema, id, expectedVersion),
      delete: (schema, id, options) => this.enqueueDelete(schema, id, options?.hard ?? false),
    };
    this.events = {
      append: (streamId, events, options) => this.enqueueAppend(streamId, events, options),
    };
  }

  async session<T>(callback: (session: Session) => Promise<T> | T): Promise<T | undefined> {
    return (
      this.tx.savepoint(async (tx) => {
        const nested = new SessionImpl(tx, this.context, this.state);
        const result = await callback(nested);
        await nested.flush();
        return result;
      }) as Promise<T>
    ).catch((error: unknown) => {
      if (error instanceof RollbackSignal) {
        return undefined;
      }
      throw error;
    });
  }

  rollback(): never {
    throw new RollbackSignal();
  }

  /** Runs every queued write and drains the queue; safe to call mid-session before a read. */
  async flush(): Promise<void> {
    const operations = this.queue.splice(0);
    for (const operation of operations) {
      await operation();
    }
  }

  private async load<TSchema extends StandardSchemaV1>(
    schema: TSchema,
    id: string | number | bigint,
    expectedVersion?: bigint,
  ): Promise<LoadedDocument<SchemaOutput<TSchema>> | undefined> {
    const registration = this.context.findDocument(schema);
    if (registration === undefined) {
      throw new Error("load: the given schema is not registered as a document type");
    }
    // Pending writes must be visible to the read: flush them first, still in this transaction.
    await this.flush();
    return loadDocument(this.tx, this.context.names, registration, id, expectedVersion);
  }

  private async enqueueDelete<TSchema extends StandardSchemaV1>(
    schema: TSchema,
    id: string | number | bigint,
    hard: boolean,
  ): Promise<void> {
    const registration = this.context.findDocument(schema);
    if (registration === undefined) {
      throw new Error("delete: the given schema is not registered as a document type");
    }
    this.queue.push(() => flushDelete(this.tx, this.context.names, registration, id, hard));
  }

  private async enqueueSave<TSchema extends StandardSchemaV1>(
    schema: TSchema,
    document: SchemaOutput<TSchema>,
    options?: { readonly expectedVersion?: bigint | "any" },
  ): Promise<void> {
    const registration = this.context.findDocument(schema);
    if (registration === undefined) {
      throw new Error("save: the given schema is not registered as a document type");
    }
    const result = await validateWith(registration.schema, document);
    if (!result.ok) {
      throw new ValidationError(
        `document "${registration.alias}" failed validation`,
        result.issues,
      );
    }
    const id = readPath(result.value, registration.idField.split("."));
    if (id === undefined) {
      throw new Error(
        `document "${registration.alias}" is missing its id field "${registration.idField}"`,
      );
    }
    const expectedVersion = options?.expectedVersion ?? DEFAULT_EXPECTED_VERSION;
    this.queue.push(() =>
      flushSave(this.tx, this.context.names, registration, id, result.value, expectedVersion),
    );
  }

  private async enqueueAppend(
    streamId: string,
    events: readonly AppendEvent[],
    options?: { readonly expectedVersion?: bigint },
  ): Promise<void> {
    if (events.length === 0) {
      throw new Error("append: at least one event is required");
    }
    const expectedVersion = options?.expectedVersion;
    const validated: AppendEvent[] = [];
    for (const event of events) {
      const registration = this.context.eventShapes.get(event.type);
      if (registration === undefined) {
        throw new Error(`append: event "${event.type}" has no registered shape`);
      }
      const result = await validateWith(registration.schema, event.data);
      if (!result.ok) {
        throw new ValidationError(`event "${event.type}" failed validation`, result.issues);
      }
      validated.push({ type: event.type, data: result.value });
    }
    this.state.pendingStreams.add(streamId);
    this.queue.push(() => flushAppend(this.tx, this.context, streamId, validated, expectedVersion));
  }
}

async function flushSave(
  tx: SessionTx,
  names: MagpieNames,
  registration: DocumentRegistration,
  id: unknown,
  data: unknown,
  expectedVersion: bigint | "any",
): Promise<void> {
  const table = tx(names.documentTable(registration.alias));
  const idCast = idCastOf(registration);
  const guard = expectedVersion === "any" ? tx`` : tx`where ${table}.version = ${expectedVersion}`;
  const rows = (await tx`
    insert into ${table} (id, version, data)
    values (${id as string | number | bigint}::${tx.unsafe(idCast)}, 1, ${tx.json(data as JSONValue)})
    on conflict (id) do update
    set version = ${table}.version + 1,
        data = excluded.data,
        last_modified = now(),
        deleted = false,
        deleted_at = null
    ${guard}
    returning version, (xmax = 0) as inserted
  `) as SaveRow[];
  const row = rows[0];
  if (row === undefined) {
    throw new ConcurrencyError(
      `document "${registration.alias}" (id ${String(id)}): expected version ${expectedVersion}, but the stored version differs`,
    );
  }
  if (row.inserted && expectedVersion !== "any" && expectedVersion > 0n) {
    throw new ConcurrencyError(
      `document "${registration.alias}" (id ${String(id)}): expected an existing row at version ${expectedVersion}, but none exists`,
    );
  }
}

async function flushAppend(
  tx: SessionTx,
  context: SessionContext,
  streamId: string,
  events: readonly AppendEvent[],
  expectedVersion: bigint | undefined,
): Promise<void> {
  const streamsTable = tx(context.names.streamsTable());
  const eventsTable = context.names.eventsTable();
  const rows = (await tx`
    select version, type from ${streamsTable} where id = ${streamId} for update
  `) as StreamRow[];
  const existing = rows[0];
  const eventCount = BigInt(events.length);

  if (existing === undefined) {
    if (expectedVersion !== undefined && expectedVersion !== 0n) {
      throw new ConcurrencyError(
        `stream "${streamId}": expected version ${expectedVersion}, but the stream does not exist`,
      );
    }
    const type = deriveStreamType(
      context,
      streamId,
      events.map((event) => event.type),
    );
    try {
      await tx`
        insert into ${streamsTable} (id, version, type)
        values (${streamId}, ${eventCount}, ${type})
      `;
      await insertEvents(tx, eventsTable, streamId, events, 1n);
    } catch (error) {
      throw concurrencyOr(error, `stream "${streamId}"`);
    }
    return;
  }

  const storedVersion = BigInt(existing.version);
  if (expectedVersion !== undefined && storedVersion !== expectedVersion) {
    throw new ConcurrencyError(
      `stream "${streamId}": expected version ${expectedVersion}, but the stream is at ${storedVersion}`,
    );
  }
  const contract =
    existing.type === null ? undefined : context.streams.get(existing.type)?.contract;
  if (contract !== undefined) {
    for (const event of events) {
      if (!contract.events.includes(event.type)) {
        throw new Error(
          `stream "${streamId}" (type "${existing.type}"): event "${event.type}" is not allowed by its stream contract`,
        );
      }
    }
  }
  try {
    await insertEvents(tx, eventsTable, streamId, events, storedVersion + 1n);
    await tx`update ${streamsTable} set version = ${storedVersion + eventCount} where id = ${streamId}`;
  } catch (error) {
    throw concurrencyOr(error, `stream "${streamId}"`);
  }
}

/** Reads one document row by id, excluding soft-deleted rows; shared by session and store. */
export async function loadDocument(
  sql: StoreReadSql,
  names: MagpieNames,
  registration: DocumentRegistration,
  id: string | number | bigint,
  expectedVersion?: bigint,
): Promise<LoadedDocument<unknown> | undefined> {
  const table = sql(names.documentTable(registration.alias));
  const rows = (await sql`
    select data, version from ${table}
    where id = ${id}::${sql.unsafe(idCastOf(registration))} and deleted = false
  `) as LoadRow[];
  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  const storedVersion = BigInt(row.version);
  if (expectedVersion !== undefined && storedVersion !== expectedVersion) {
    throw new ConcurrencyError(
      `document "${registration.alias}" (id ${String(id)}): expected version ${expectedVersion}, but the stored version is ${storedVersion}`,
    );
  }
  return { data: row.data, version: storedVersion };
}

async function flushDelete(
  tx: SessionTx,
  names: MagpieNames,
  registration: DocumentRegistration,
  id: string | number | bigint,
  hard: boolean,
): Promise<void> {
  const table = tx(names.documentTable(registration.alias));
  if (hard) {
    await tx`delete from ${table} where id = ${id}::${tx.unsafe(idCastOf(registration))}`;
    return;
  }
  await tx`update ${table}
    set deleted = true, deleted_at = now()
    where id = ${id}::${tx.unsafe(idCastOf(registration))} and deleted = false`;
}

/** The explicit cast of the registered id field, `text` when unset. */
function idCastOf(registration: DocumentRegistration): string {
  const idField = registration.fields.find(
    (field) => field.path.join(".") === registration.idField,
  );
  return idField?.cast ?? "text";
}

async function insertEvents(
  tx: SessionTx,
  eventsTable: string,
  streamId: string,
  events: readonly AppendEvent[],
  firstVersion: bigint,
): Promise<void> {
  const table = tx(eventsTable);
  let version = firstVersion;
  for (const event of events) {
    await tx`
      insert into ${table} (stream_id, version, type, data)
      values (${streamId}, ${version}, ${event.type}, ${tx.json(event.data as JSONValue)})
    `;
    version += 1n;
  }
}

/** The single registered stream whose contract admits every appended event; null when ungoverned. */
function deriveStreamType(
  context: SessionContext,
  streamId: string,
  eventTypes: readonly string[],
): string | null {
  const candidates: string[] = [];
  for (const [name, registration] of context.streams) {
    if (eventTypes.every((type) => registration.contract.events.includes(type))) {
      candidates.push(name);
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0] ?? null;
  }
  throw new Error(
    `cannot determine the type of stream "${streamId}": events [${eventTypes.join(", ")}] match multiple stream registrations (${candidates.join(", ")})`,
  );
}

function concurrencyOr(error: unknown, where: string): unknown {
  if (error instanceof Error && (error as { readonly code?: unknown }).code === "23505") {
    return new ConcurrencyError(`${where}: a concurrent write won; retry with the current version`);
  }
  return error;
}

function readPath(value: unknown, segments: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
