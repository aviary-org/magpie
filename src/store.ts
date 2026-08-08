import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Sql } from "postgres";
import { type DocumentConfigFn, resolveDocumentConfig } from "./document.js";
import {
  type EventReadContext,
  foldStream,
  readStreamHistory,
  type StoredEvent,
} from "./events.js";
import { applyMigrations } from "./migrate.js";
import { makeNames } from "./naming.js";
import { type DocumentQuery, makeDocumentQuery, makeQueryNode, type QueryNode } from "./query.js";
import type {
  AggregateRegistration,
  DocumentRegistration,
  EventRegistration,
  FoldFn,
  InlineProjection,
  StreamContract,
  StreamRegistration,
  UpcasterFn,
  UpcasterRegistration,
} from "./registry.js";
import {
  type LoadedDocument,
  loadDocument,
  runSession,
  type Session,
  type SessionContext,
  type StoreReadSql,
} from "./session.js";
import { isStandardSchema, type SchemaOutput } from "./standard-schema.js";

/** Options for {@link createStore}. */
export interface StoreOptions {
  /** User-owned postgres-js instance; magpie never opens its own connections. */
  readonly sql: Sql;
  /** Postgres schema all magpie objects live in (default `public`). */
  readonly schema?: string;
  /** Lazily create missing schema at runtime; dev/test only (default `false`). */
  readonly autoCreate?: boolean;
}

/** The store: registration surface for documents, events, streams, upcasters, and aggregates. */
export interface Store {
  document<TSchema extends StandardSchemaV1>(
    schema: TSchema,
    config?: DocumentConfigFn<TSchema>,
  ): void;
  event(name: string, schema: StandardSchemaV1): void;
  stream(name: string, contract: StreamContract): void;
  upcaster(storedName: string, upcast: UpcasterFn): void;
  /**
   * Registers a fold over a stream, keyed by the output schema so `store.fold` can
   * invoke it live. With `inline: true` the same definition also persists its output
   * into a document table on every append, inside the append's transaction.
   */
  aggregate(
    streamName: string,
    schema: StandardSchemaV1,
    fold: FoldFn,
    options?: { readonly inline?: boolean },
  ): void;
  /** Runs a callback in one transaction; queued writes commit or roll back together. */
  session<T>(callback: (session: Session) => Promise<T> | T): Promise<T | undefined>;
  /**
   /** Reads a document by id outside a session; returns nothing when absent
    * (soft-deleted rows count as absent). An `expectedVersion` guards the read.
    */
  load<TSchema extends StandardSchemaV1>(
    schema: TSchema,
    id: string | number | bigint,
    expectedVersion?: bigint,
  ): Promise<LoadedDocument<SchemaOutput<TSchema>> | undefined>;
  /** A typed field-path builder for query filters and sorts over a shape. */
  path<T>(): QueryNode<T, []>;
  /** Starts a query over a registered document type; filters, sorts, paginates. */
  query<TSchema extends StandardSchemaV1>(schema: TSchema): DocumentQuery<SchemaOutput<TSchema>>;
  /**
   * Reads a stream's event history in version order; `fromVersion` starts the returned
   * slice at that version. Absent streams read as an empty history.
   */
  readStream(
    streamId: string,
    options?: { readonly fromVersion?: bigint },
  ): Promise<readonly StoredEvent[]>;
  /**
   * Folds a stream's events on demand with a registered aggregate; nothing when the
   * stream has no events. Aggregates are keyed by their output schema, so several
   * aggregates may fold the same stream independently.
   */
  fold<TSchema extends StandardSchemaV1>(
    schema: TSchema,
    streamId: string,
  ): Promise<SchemaOutput<TSchema> | undefined>;
  /** Applies all registered schema idempotently; safe to re-run. */
  migrate(): Promise<void>;
}

const DEFAULT_SCHEMA = "public";
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]*$/;
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export function createStore(options: StoreOptions): Store {
  if (!options?.sql) {
    throw new Error("createStore requires a postgres sql instance");
  }
  const sql = options.sql;
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_PATTERN.test(schema)) {
    throw new Error(`createStore: schema must be a bare Postgres identifier, got "${schema}"`);
  }
  const autoCreate = options.autoCreate ?? false;
  if (options.autoCreate !== undefined && typeof options.autoCreate !== "boolean") {
    throw new Error("createStore: autoCreate must be a boolean");
  }

  const names = makeNames(schema);

  const documentTypes = new Map<string, DocumentRegistration>();
  const documentBySchema = new Map<StandardSchemaV1, DocumentRegistration>();
  const eventShapes = new Map<string, EventRegistration>();
  const streams = new Map<string, StreamRegistration>();
  const upcasters = new Map<string, UpcasterRegistration>();
  const aggregateBySchema = new Map<StandardSchemaV1, AggregateRegistration>();
  // The document-like registrations backing inline aggregate snapshot tables.
  const inlineAggregateDocuments = new Map<StandardSchemaV1, DocumentRegistration>();
  // Inline projections keyed by the stream name they fold, for the session write path.
  const inlineProjections = new Map<string, InlineProjection[]>();

  const sessionContext: SessionContext = {
    names,
    eventShapes,
    streams,
    findDocument: (schema) => documentBySchema.get(schema),
  };

  const eventReadContext: EventReadContext = {
    names,
    eventShapes,
    upcasters,
  };

  function requireStandardSchema(value: unknown, what: string): void {
    if (!isStandardSchema(value)) {
      throw new Error(`${what} must be a Standard Schema (version 1 with a validate function)`);
    }
  }

  function requireName(name: string, kind: string): void {
    if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
      throw new Error(`${kind} name must match ${NAME_PATTERN}, got "${String(name)}"`);
    }
  }

  let migrated = false;

  /** Every document table the DDL must know about, hand-registered and snapshot tables. */
  function allDocumentRegistrations(): readonly DocumentRegistration[] {
    return [...documentTypes.values(), ...inlineAggregateDocuments.values()];
  }

  async function ensureMigrated(): Promise<void> {
    if (migrated) {
      return;
    }
    await applyMigrations(sql, names, allDocumentRegistrations());
    migrated = true;
  }

  return {
    document(schema, config) {
      requireStandardSchema(schema, "document schema");
      const resolved = resolveDocumentConfig(schema, config);
      if (documentTypes.has(resolved.alias)) {
        throw new Error(`document "${resolved.alias}" is already registered`);
      }
      const registration: DocumentRegistration = {
        schema,
        alias: resolved.alias,
        idField: resolved.idField,
        fields: resolved.fields,
      };
      documentTypes.set(registration.alias, registration);
      documentBySchema.set(schema, registration);
      migrated = false;
    },
    event(name, schema) {
      requireName(name, "event");
      requireStandardSchema(schema, `event "${name}" schema`);
      if (eventShapes.has(name)) {
        throw new Error(`event "${name}" is already registered`);
      }
      eventShapes.set(name, { schema });
    },
    stream(name, contract) {
      requireName(name, "stream");
      if (streams.has(name)) {
        throw new Error(`stream "${name}" is already registered`);
      }
      for (const eventName of contract.events) {
        if (!eventShapes.has(eventName)) {
          throw new Error(`stream "${name}" references unknown event "${eventName}"`);
        }
      }
      streams.set(name, { contract });
    },
    upcaster(storedName, upcast) {
      requireName(storedName, "upcaster");
      if (upcasters.has(storedName)) {
        throw new Error(`upcaster for stored event "${storedName}" is already registered`);
      }
      upcasters.set(storedName, { upcast });
    },
    aggregate(streamName, schema, fold, options) {
      requireName(streamName, "aggregate");
      requireStandardSchema(schema, `aggregate "${streamName}" schema`);
      if (!streams.has(streamName)) {
        throw new Error(`aggregate references unknown stream "${streamName}"`);
      }
      if (aggregateBySchema.has(schema)) {
        throw new Error(
          `aggregate for stream "${streamName}": an aggregate with this output schema is already registered`,
        );
      }
      const inline = options?.inline ?? false;
      if (options?.inline !== undefined && typeof options.inline !== "boolean") {
        throw new Error(`aggregate "${streamName}": inline must be a boolean`);
      }
      aggregateBySchema.set(schema, { streamName, schema, fold, inline });
      if (inline) {
        const resolved = resolveDocumentConfig(schema);
        inlineAggregateDocuments.set(schema, {
          schema,
          alias: resolved.alias,
          idField: resolved.idField,
          fields: resolved.fields,
        });
        const existing = inlineProjections.get(streamName) ?? [];
        inlineProjections.set(streamName, [...existing, { alias: resolved.alias, fold }]);
        migrated = false;
      }
    },
    async session<T>(callback: (session: Session) => Promise<T> | T): Promise<T | undefined> {
      if (autoCreate) {
        await ensureMigrated();
      }
      return runSession(sql, sessionContext, callback);
    },
    async migrate() {
      // autoCreate is the dev-mode convenience path: memoized until a new
      // document registration changes the schema. The explicit path always
      // re-applies, so a manual drop is recovered by re-running migrate.
      if (autoCreate) {
        await ensureMigrated();
        return;
      }
      await applyMigrations(sql, names, allDocumentRegistrations());
    },
    async load<TSchema extends StandardSchemaV1>(
      schema: TSchema,
      id: string | number | bigint,
      expectedVersion?: bigint,
    ): Promise<LoadedDocument<SchemaOutput<TSchema>> | undefined> {
      if (autoCreate) {
        await ensureMigrated();
      }
      const registration = documentBySchema.get(schema);
      if (registration === undefined) {
        throw new Error("load: the given schema is not registered as a document type");
      }
      return loadDocument(sql as unknown as StoreReadSql, names, registration, id, expectedVersion);
    },
    path: <T>() => makeQueryNode() as unknown as QueryNode<T, []>,
    query<TSchema extends StandardSchemaV1>(schema: TSchema): DocumentQuery<SchemaOutput<TSchema>> {
      const registration = documentBySchema.get(schema);
      if (registration === undefined) {
        throw new Error("query: the given schema is not registered as a document type");
      }
      return makeDocumentQuery(sql, names, registration, ensureMigrated) as DocumentQuery<
        SchemaOutput<TSchema>
      >;
    },
    async readStream(streamId, options) {
      if (autoCreate) {
        await ensureMigrated();
      }
      return readStreamHistory(
        sql as unknown as StoreReadSql,
        eventReadContext,
        streamId,
        options?.fromVersion,
      );
    },
    async fold<TSchema extends StandardSchemaV1>(
      schema: TSchema,
      streamId: string,
    ): Promise<SchemaOutput<TSchema> | undefined> {
      if (autoCreate) {
        await ensureMigrated();
      }
      const registration = aggregateBySchema.get(schema);
      if (registration === undefined) {
        throw new Error("fold: the given schema is not registered as an aggregate output");
      }
      const state = await foldStream(
        sql as unknown as StoreReadSql,
        eventReadContext,
        registration.fold,
        streamId,
      );
      return state as SchemaOutput<TSchema> | undefined;
    },
  };
}
