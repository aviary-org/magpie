import type { FieldSpec } from "./document.js";
import type { ImmutableCastKind, MagpieNames } from "./naming.js";
import type { DocumentRegistration } from "./registry.js";

/** Path segments become quoted column names, so mixed case is fine. */
const COLUMN_SEGMENT_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Casts whose extraction must go through the immutable wrapper functions. */
const WRAPPER_CASTS: ReadonlySet<string> = new Set(["timestamptz", "timestamp", "date"]);

/** The generated, index-supporting column for one indexed document field. */
export interface DuplicatedColumn {
  readonly name: string;
  readonly type: string;
  readonly expression: string;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(qualified: string): string {
  const dot = qualified.indexOf(".");
  return dot === -1
    ? quoteIdentifier(qualified)
    : `${quoteIdentifier(qualified.slice(0, dot))}.${quoteIdentifier(qualified.slice(dot + 1))}`;
}

/** SQL text extracting a JSON value as text: `data #>> '<path literal>'`. */
export function dataExtraction(path: readonly string[]): string {
  const keys = path
    .map((segment) => `"${segment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",")
    .replace(/'/g, "''");
  return `data #>> '{${keys}}'`;
}

/**
 * The duplicated column name for a document field path, `f_<path joined by _>`.
 * Indexed paths are constrained to identifier-safe segments so the column can
 * be referenced from DDL and from queries without quoting.
 */
export function duplicatedColumnName(path: readonly string[]): string {
  for (const segment of path) {
    if (!COLUMN_SEGMENT_PATTERN.test(segment)) {
      throw new Error(
        `field path "${path.join(".")}" cannot be indexed: segment "${segment}" must match ${COLUMN_SEGMENT_PATTERN}`,
      );
    }
  }
  return `f_${path.join("_")}`;
}

/** The duplicated column definition for one indexed document field. */
export function duplicatedColumn(field: FieldSpec, names: MagpieNames): DuplicatedColumn {
  const name = duplicatedColumnName(field.path);
  const type = field.cast ?? "text";
  const extraction = dataExtraction(field.path);
  return { name, type, expression: castExpression(extraction, field.cast, names) };
}

function castExpression(extraction: string, cast: string | undefined, names: MagpieNames): string {
  if (cast === undefined) {
    return extraction;
  }
  if (WRAPPER_CASTS.has(cast)) {
    return `${quoteQualified(names.immutableCast(cast as ImmutableCastKind))}(${extraction})`;
  }
  return `(${extraction})::${cast}`;
}

function idColumnType(registration: DocumentRegistration): string {
  const idField = registration.fields.find(
    (field) => field.path.join(".") === registration.idField,
  );
  return idField?.cast ?? "text";
}

function indexedColumns(
  registration: DocumentRegistration,
  names: MagpieNames,
): readonly DuplicatedColumn[] {
  return registration.fields
    .filter((field) => field.isIndexed && field.path.join(".") !== registration.idField)
    .map((field) => duplicatedColumn(field, names));
}

function assertUniqueColumns(columns: readonly DuplicatedColumn[], alias: string): void {
  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column.name)) {
      throw new Error(
        `document "${alias}": fields map to the same duplicated column "${column.name}"; use distinct field names`,
      );
    }
    seen.add(column.name);
  }
}

function documentIndexName(alias: string, column: string): string {
  return `magpie_doc_${alias}_${column}_idx`;
}

function documentGinIndexName(alias: string): string {
  return `magpie_doc_${alias}_data_gin`;
}

/** Idempotent DDL for one registered document type. */
export function documentTableStatements(
  names: MagpieNames,
  registration: DocumentRegistration,
): readonly string[] {
  const table = quoteQualified(names.documentTable(registration.alias));
  const columns = indexedColumns(registration, names);
  assertUniqueColumns(columns, registration.alias);

  const columnDefs = [
    `id ${idColumnType(registration)} PRIMARY KEY`,
    "version bigint NOT NULL",
    "data jsonb NOT NULL",
    "last_modified timestamptz NOT NULL DEFAULT now()",
    "deleted boolean NOT NULL DEFAULT false",
    "deleted_at timestamptz",
    ...columns.map(
      (column) =>
        `${quoteIdentifier(column.name)} ${column.type} GENERATED ALWAYS AS (${column.expression}) STORED`,
    ),
  ];

  const statements = [`CREATE TABLE IF NOT EXISTS ${table} (\n  ${columnDefs.join(",\n  ")}\n)`];

  // A table created before a field was indexed gains its duplicated column here.
  for (const column of columns) {
    statements.push(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(column.name)} ${column.type} GENERATED ALWAYS AS (${column.expression}) STORED`,
    );
  }

  for (const column of columns) {
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(documentIndexName(registration.alias, column.name))} ON ${table} (${quoteIdentifier(column.name)})`,
    );
  }

  if (registration.fields.some((field) => field.hasContainsIndex)) {
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(documentGinIndexName(registration.alias))} ON ${table} USING gin (data jsonb_path_ops)`,
    );
  }

  return statements;
}

/** Idempotent DDL for the fixed event-storage objects. */
export function eventStorageStatements(names: MagpieNames): readonly string[] {
  const sequence = quoteQualified(names.eventsSequence());
  const events = quoteQualified(names.eventsTable());
  const streams = quoteQualified(names.streamsTable());
  return [
    `CREATE SEQUENCE IF NOT EXISTS ${sequence}`,
    `CREATE TABLE IF NOT EXISTS ${events} (\n` +
      `  id bigint PRIMARY KEY DEFAULT nextval('${names.eventsSequence()}'),\n` +
      "  stream_id text NOT NULL,\n" +
      "  version bigint NOT NULL,\n" +
      "  type text NOT NULL,\n" +
      "  data jsonb NOT NULL,\n" +
      "  timestamp timestamptz NOT NULL DEFAULT now()\n" +
      ")",
    `CREATE UNIQUE INDEX IF NOT EXISTS magpie_events_stream_version_idx ON ${events} (stream_id, version)`,
    `CREATE TABLE IF NOT EXISTS ${streams} (\n` +
      "  id text PRIMARY KEY,\n" +
      "  version bigint NOT NULL,\n" +
      // NULL marks a stream no registration governs (audit-style appends).
      "  type text\n" +
      ")",
  ];
}

/** Idempotent DDL for the immutable jsonb cast wrappers. */
export function immutableCastStatements(names: MagpieNames): readonly string[] {
  const kinds: readonly ImmutableCastKind[] = ["timestamptz", "timestamp", "date"];
  return kinds.map((kind) => {
    const fn = quoteQualified(names.immutableCast(kind));
    return `CREATE OR REPLACE FUNCTION ${fn}(text) RETURNS ${kind} LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT $1::${kind} $$`;
  });
}

/** Every DDL statement for the registered schema, in dependency order. */
export function migrationStatements(
  names: MagpieNames,
  documents: readonly DocumentRegistration[],
): readonly string[] {
  const statements: string[] = [];
  if (names.schema !== "public") {
    statements.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(names.schema)}`);
  }
  statements.push(...immutableCastStatements(names));
  statements.push(...eventStorageStatements(names));
  for (const document of documents) {
    statements.push(...documentTableStatements(names, document));
  }
  return statements;
}
