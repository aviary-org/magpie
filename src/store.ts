import type { Sql } from "postgres";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { resolveDocumentConfig, type DocumentConfigFn } from "./document.js";
import { isStandardSchema } from "./standard-schema.js";
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
  document<TSchema extends StandardSchemaV1>(schema: TSchema, config?: DocumentConfigFn<TSchema>): void;
  event(name: string, schema: StandardSchemaV1): void;
  stream(name: string, contract: StreamContract): void;
  upcaster(storedName: string, upcast: UpcasterFn): void;
  aggregate(streamName: string, schema: StandardSchemaV1, fold: FoldFn): void;
}

const DEFAULT_SCHEMA = "public";
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]*$/;
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export function createStore(options: StoreOptions): Store {
  if (!options?.sql) {
    throw new Error("createStore requires a postgres sql instance");
  }
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_PATTERN.test(schema)) {
    throw new Error(`createStore: schema must be a bare Postgres identifier, got "${schema}"`);
  }
  if (options.autoCreate !== undefined && typeof options.autoCreate !== "boolean") {
    throw new Error("createStore: autoCreate must be a boolean");
  }

  const documentTypes = new Map<string, DocumentRegistration>();
  const eventShapes = new Map<string, EventRegistration>();
  const streams = new Map<string, StreamRegistration>();
  const upcasters = new Map<string, UpcasterRegistration>();
  const aggregates: AggregateRegistration[] = [];

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

  return {
    document(schema, config) {
      requireStandardSchema(schema, "document schema");
      const resolved = resolveDocumentConfig(schema, config);
      if (documentTypes.has(resolved.alias)) {
        throw new Error(`document "${resolved.alias}" is already registered`);
      }
      documentTypes.set(resolved.alias, {
        schema,
        alias: resolved.alias,
        idField: resolved.idField,
        fields: resolved.fields,
      });
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
  };
}
