import { pathToFileURL } from "node:url";
import postgres from "postgres";
import type { Store } from "./store.js";

const USAGE = `magpie — Postgres as a document store, an event store, and one consistency boundary

Usage:
  magpie migrate --config <file> [--database-url <url>]

Commands:
  migrate   Apply the registered schema idempotently

Options:
  --config <file>       Module exporting a default (sql) => Store function
  --database-url <url>  Postgres connection string (default: $DATABASE_URL)
  --help, -h            Show this help
`;

export interface CliOptions {
  readonly config: string;
  readonly databaseUrl: string;
}

/** Loads the config module, connects, and runs the store's migrate. */
export async function runMigrate(options: CliOptions): Promise<void> {
  const configModule = await import(pathToFileURL(options.config).href);
  const makeStore = (configModule as { readonly default?: unknown }).default;
  if (typeof makeStore !== "function") {
    throw new Error(
      `migrate: config module "${options.config}" must export a default function (sql) => Store`,
    );
  }
  const sql = postgres(options.databaseUrl, { onnotice: () => {} });
  try {
    const store = makeStore(sql) as Store;
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

interface ParsedArgs {
  readonly config: string | undefined;
  readonly databaseUrl: string | undefined;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let config: string | undefined;
  let databaseUrl: string | undefined;
  let help = false;
  let sawCommand = false;
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
          throw new Error("migrate: --config requires a file path");
        }
        i += inlineValue === undefined ? 1 : 0;
      } else if (flag === "--database-url") {
        databaseUrl = inlineValue ?? argv[i + 1];
        if (databaseUrl === undefined) {
          throw new Error("migrate: --database-url requires a connection string");
        }
        i += inlineValue === undefined ? 1 : 0;
      } else {
        throw new Error(`unknown argument "${arg}"`);
      }
    } else if (arg === "migrate" && !sawCommand) {
      sawCommand = true;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return { config, databaseUrl, help };
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
  const config = parsed.config;
  if (config === undefined) {
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
  try {
    await runMigrate({ config, databaseUrl });
    process.stdout.write("magpie: migrate complete\n");
    return 0;
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
