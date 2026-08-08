import { pathToFileURL } from "node:url";
import postgres, { type Sql } from "postgres";
import type { ValidationIssue } from "./standard-schema.js";
import type { Store } from "./store.js";
import type { ValidationReport } from "./validate.js";

const USAGE = `magpie — Postgres as a document store, an event store, and one consistency boundary

Usage:
  magpie migrate --config <file> [--database-url <url>]
  magpie validate [<streamId|all>] --config <file> [--database-url <url>] [--documents] [--json]

Commands:
  migrate    Apply the registered schema idempotently
  validate   Scan stored data against the registered shapes; exit non-zero on mismatches

Options:
  --config <file>       Module exporting a default (sql) => Store function
  --database-url <url>  Postgres connection string (default: $DATABASE_URL)
  --documents           Also scan every registered document type's rows (validate only)
  --json                Emit the report as JSON for automation (validate only)
  --help, -h            Show this help
`;

export interface CliOptions {
  readonly config: string;
  readonly databaseUrl: string;
}

/** Loads the config module, connects, and runs the store's migrate. */
export async function runMigrate(options: CliOptions): Promise<void> {
  const { sql, store } = await loadStore(options);
  try {
    if (typeof store.migrate !== "function") {
      throw new Error(
        `migrate: config module "${options.config}" must return a store with migrate()`,
      );
    }
    await store.migrate();
  } finally {
    await sql.end();
  }
}

/** Options for the validate command. */
export interface ValidateCliOptions {
  readonly config: string;
  readonly databaseUrl: string;
  /** The stream to scan; undefined or "all" scans every stream's events. */
  readonly target: string | undefined;
  readonly documents: boolean;
  readonly json: boolean;
}

/** Runs a validate scan and prints the report; returns the process exit code. */
export async function runValidate(options: ValidateCliOptions): Promise<number> {
  const { sql, store } = await loadStore(options);
  try {
    if (typeof store.validate !== "function") {
      throw new Error(
        `validate: config module "${options.config}" must return a store with validate()`,
      );
    }
    const streamId =
      options.target === undefined || options.target === "all" ? undefined : options.target;
    const report = await store.validate({
      ...(streamId === undefined ? {} : { streamId }),
      ...(options.documents ? { documents: true } : {}),
    });
    process.stdout.write(options.json ? `${reportJson(report)}\n` : formatValidateReport(report));
    return report.mismatches.length === 0 ? 0 : 1;
  } finally {
    await sql.end();
  }
}

async function loadStore(
  options: CliOptions,
): Promise<{ readonly sql: Sql; readonly store: Store }> {
  const configModule = await import(pathToFileURL(options.config).href);
  const makeStore = (configModule as { readonly default?: unknown }).default;
  if (typeof makeStore !== "function") {
    throw new Error(
      `config module "${options.config}" must export a default function (sql) => Store`,
    );
  }
  const sql = postgres(options.databaseUrl, { onnotice: () => {} });
  return { sql, store: makeStore(sql) as Store };
}

/** Renders the validate report for humans; each mismatch on its own line. */
export function formatValidateReport(report: ValidationReport): string {
  const lines = [
    "magpie: validate complete",
    `scanned ${report.events} event rows, ${report.documents} document rows; ${report.mismatches.length} mismatch${report.mismatches.length === 1 ? "" : "es"}`,
  ];
  if (report.mismatches.length > 0) {
    lines.push("", "mismatches:");
    for (const mismatch of report.mismatches) {
      lines.push(`  ${formatMismatchLine(mismatch)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Renders the validate report as JSON; bigint identifiers serialize as strings. */
export function reportJson(report: ValidationReport): string {
  return JSON.stringify(
    report,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

function formatMismatchLine(mismatch: ValidationReport["mismatches"][number]): string {
  const issues = mismatch.issues
    .map((issue) => {
      const path = formatIssuePath(issue.path);
      return path === undefined ? issue.message : `${issue.message} (at ${path})`;
    })
    .join("; ");
  if (mismatch.kind === "event") {
    return `event ${mismatch.type} at stream ${mismatch.streamId} version ${mismatch.version}: ${issues}`;
  }
  return `document ${mismatch.type} id ${mismatch.id}: ${issues}`;
}

function formatIssuePath(path: ValidationIssue["path"]): string | undefined {
  if (path === undefined || path.length === 0) {
    return undefined;
  }
  return path
    .map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String(segment.key)
        : String(segment),
    )
    .join(".");
}

interface ParsedArgs {
  readonly command: "migrate" | "validate" | undefined;
  readonly target: string | undefined;
  readonly config: string | undefined;
  readonly databaseUrl: string | undefined;
  readonly documents: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: "migrate" | "validate" | undefined;
  let target: string | undefined;
  let config: string | undefined;
  let databaseUrl: string | undefined;
  let documents = false;
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const flag = equals === -1 ? arg : arg.slice(0, equals);
      const inlineValue = equals === -1 ? undefined : arg.slice(equals + 1);
      if (flag === "--config") {
        config = inlineValue ?? argv[i + 1];
        if (config === undefined) {
          throw new Error("--config requires a file path");
        }
        i += inlineValue === undefined ? 1 : 0;
      } else if (flag === "--database-url") {
        databaseUrl = inlineValue ?? argv[i + 1];
        if (databaseUrl === undefined) {
          throw new Error("--database-url requires a connection string");
        }
        i += inlineValue === undefined ? 1 : 0;
      } else if (flag === "--documents") {
        documents = true;
      } else if (flag === "--json") {
        json = true;
      } else {
        throw new Error(`unknown argument "${arg}"`);
      }
    } else if (command === undefined) {
      if (arg === "migrate" || arg === "validate") {
        command = arg;
      } else {
        throw new Error(`unknown argument "${arg}"`);
      }
    } else if (command === "validate" && target === undefined) {
      target = arg;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return { command, target, config, databaseUrl, documents, json, help };
}

/** Runs the CLI; returns the process exit code. */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(
      `magpie: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
    return 1;
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.command === undefined) {
    process.stderr.write(`magpie: missing command; expected migrate or validate\n\n${USAGE}`);
    return 1;
  }
  if (parsed.config === undefined) {
    process.stderr.write(`magpie: missing --config <file>\n\n${USAGE}`);
    return 1;
  }
  const databaseUrl = parsed.databaseUrl ?? env.DATABASE_URL;
  if (databaseUrl === undefined) {
    process.stderr.write(
      `magpie: missing database url; pass --database-url or set DATABASE_URL\n\n${USAGE}`,
    );
    return 1;
  }
  if (parsed.command === "migrate" && (parsed.documents || parsed.json)) {
    process.stderr.write(`magpie: migrate accepts only --config and --database-url\n\n${USAGE}`);
    return 1;
  }
  try {
    if (parsed.command === "migrate") {
      await runMigrate({ config: parsed.config, databaseUrl });
      process.stdout.write("magpie: migrate complete\n");
      return 0;
    }
    return await runValidate({
      config: parsed.config,
      databaseUrl,
      target: parsed.target,
      documents: parsed.documents,
      json: parsed.json,
    });
  } catch (error) {
    process.stderr.write(`magpie: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  process.exit(await main(process.argv.slice(2), process.env));
}
