import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Sql } from "postgres";
import { type DocumentConfigFn, resolveDocumentConfig } from "./document.js";
import { applyMigrations } from "./migrate.js";
import { makeNames } from "./naming.js";
import type {
  AggregateRegistration,
  DocumentRegistration,
  EventRegistration,
  FoldFn,
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
  aggregate(streamName: string, schema: StandardSchemaV1, fold: FoldFn): void;
  /** Runs a callback in one transaction; queued writes commit or roll back together. */
  session<T>(callback: (session: Session) => Promise<T> | T): Promise<T | undefined>;
  /**
   * Reads a document by id outside a session; returns nothing when absent
   * (soft-deleted rows count as absent). An `expectedVersion` guards the read.
   */
  load<TSchema extends StandardSchemaV1>(
    schema: TSchema,
    id: string | number | bigint,
    expectedVersion?: bigint,
  ): Promise<LoadedDocument<SchemaOutput<TSchema>> | undefined>;
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
  const aggregates: AggregateRegistration[] = [];

  const sessionContext: SessionContext = {
    names,
    eventShapes,
    streams,
    findDocument: (schema) => documentBySchema.get(schema),
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

  async function ensureMigrated(): Promise<void> {
    if (migrated) {
      return;
    }
    await applyMigrations(sql, names, [...documentTypes.values()]);
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
    aggregate(streamName, schema, fold) {
      requireName(streamName, "aggregate");
      requireStandardSchema(schema, `aggregate "${streamName}" schema`);
      if (!streams.has(streamName)) {
        throw new Error(`aggregate references unknown stream "${streamName}"`);
      }
      aggregates.push({ streamName, schema, fold });
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
      await applyMigrations(sql, names, [...documentTypes.values()]);
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
  };
}
