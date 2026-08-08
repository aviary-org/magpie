import type { ISql } from "postgres";
import type { MagpieNames } from "./naming.js";
import type { DocumentRegistration, EventRegistration, UpcasterRegistration } from "./registry.js";
import { type ValidationIssue, validateWith } from "./standard-schema.js";

/** Scope and options for the integrity validation operation. */
export interface ValidateOptions {
  /** Scan only this stream's event rows; the default scans every stream's events. */
  readonly streamId?: string;
  /** Also scan every registered document type's rows (default false). */
  readonly documents?: boolean;
}

/** One stored row that does not conform to its registered shape. */
export type ValidationMismatch =
  | {
      readonly kind: "event";
      /** The global event row id from the shared sequence. */
      readonly id: bigint;
      readonly streamId: string;
      readonly version: bigint;
      readonly type: string;
      readonly issues: readonly ValidationIssue[];
    }
  | {
      readonly kind: "document";
      /** The document row id, as text. */
      readonly id: string;
      readonly type: string;
      readonly issues: readonly ValidationIssue[];
    };

/** The outcome of one validation run: scan counts plus every mismatching row. */
export interface ValidationReport {
  /** Event rows scanned. */
  readonly events: number;
  /** Document rows scanned; zero when document scanning was not requested. */
  readonly documents: number;
  readonly mismatches: readonly ValidationMismatch[];
}

/** The registrations and naming the validation scan needs. */
export interface ValidateContext {
  readonly names: MagpieNames;
  readonly eventShapes: ReadonlyMap<string, EventRegistration>;
  readonly upcasters: ReadonlyMap<string, UpcasterRegistration>;
  /** Registered document types keyed by their table alias. */
  readonly documents: ReadonlyMap<string, DocumentRegistration>;
}

/** Read handle with the same parameter admission as the store's read paths. */
type ValidateSql = ISql<{ int8: bigint }>;

interface EventScanRow {
  readonly id: string;
  readonly stream_id: string;
  readonly version: string;
  readonly type: string;
  readonly data: unknown;
}

interface DocumentScanRow {
  readonly id: string;
  readonly data: unknown;
}

interface ScanResult {
  readonly count: number;
  readonly mismatches: readonly ValidationMismatch[];
}

/**
 * Scans stored rows against the registered shapes and reports mismatches; never
 * writes. Every event row (or one stream's) is upcast first when an upcaster
 * applies, then validated against the shape registered under its stored name;
 * optionally, every row of each registered document type is validated against
 * its document schema. Rows whose type has no registered shape are reported as
 * mismatches, so imported data that the store never ingested is surfaced here.
 */
export async function validateStore(
  sql: ValidateSql,
  context: ValidateContext,
  options: ValidateOptions,
): Promise<ValidationReport> {
  const events = await scanEvents(sql, context, options.streamId);
  const documents =
    options.documents === true ? await scanDocuments(sql, context) : { count: 0, mismatches: [] };
  return {
    events: events.count,
    documents: documents.count,
    mismatches: [...events.mismatches, ...documents.mismatches],
  };
}

async function scanEvents(
  sql: ValidateSql,
  context: ValidateContext,
  streamId: string | undefined,
): Promise<ScanResult> {
  const table = sql(context.names.eventsTable());
  const rows = (
    streamId === undefined
      ? await sql`select id, stream_id, version, type, data from ${table} order by stream_id, version asc`
      : await sql`select id, stream_id, version, type, data from ${table} where stream_id = ${streamId} order by version asc`
  ) as EventScanRow[];
  const mismatches: ValidationMismatch[] = [];
  for (const row of rows) {
    const mismatch = await validateEventRow(context, row);
    if (mismatch !== undefined) {
      mismatches.push(mismatch);
    }
  }
  return { count: rows.length, mismatches };
}

async function validateEventRow(
  context: ValidateContext,
  row: EventScanRow,
): Promise<ValidationMismatch | undefined> {
  const shape = context.eventShapes.get(row.type);
  if (shape === undefined) {
    return eventMismatch(row, [{ message: `event type "${row.type}" has no registered shape` }]);
  }
  let data = row.data;
  const upcaster = context.upcasters.get(row.type);
  try {
    if (upcaster !== undefined) {
      data = upcaster.upcast(row.data);
    }
    const result = await validateWith(shape.schema, data);
    if (result.ok) {
      return undefined;
    }
    return eventMismatch(row, result.issues);
  } catch (error) {
    return eventMismatch(row, [thrownIssue(error)]);
  }
}

function eventMismatch(row: EventScanRow, issues: readonly ValidationIssue[]): ValidationMismatch {
  return {
    kind: "event",
    id: BigInt(row.id),
    streamId: row.stream_id,
    version: BigInt(row.version),
    type: row.type,
    issues,
  };
}

async function scanDocuments(sql: ValidateSql, context: ValidateContext): Promise<ScanResult> {
  let count = 0;
  const mismatches: ValidationMismatch[] = [];
  for (const registration of context.documents.values()) {
    const table = sql(context.names.documentTable(registration.alias));
    const rows = (await sql`select id::text as id, data from ${table}`) as DocumentScanRow[];
    count += rows.length;
    for (const row of rows) {
      try {
        const result = await validateWith(registration.schema, row.data);
        if (!result.ok) {
          mismatches.push({
            kind: "document",
            id: row.id,
            type: registration.alias,
            issues: result.issues,
          });
        }
      } catch (error) {
        mismatches.push({
          kind: "document",
          id: row.id,
          type: registration.alias,
          issues: [thrownIssue(error)],
        });
      }
    }
  }
  return { count, mismatches };
}

function thrownIssue(error: unknown): ValidationIssue {
  return {
    message: `validation failed with an error: ${error instanceof Error ? error.message : String(error)}`,
  };
}
