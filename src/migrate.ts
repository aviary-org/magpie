import type { Sql } from "postgres";
import { migrationStatements } from "./ddl.js";
import type { MagpieNames } from "./naming.js";
import type { DocumentRegistration } from "./registry.js";

/** Applies the registered schema idempotently and atomically, in one transaction. */
export async function applyMigrations(
  sql: Sql,
  names: MagpieNames,
  documents: readonly DocumentRegistration[],
): Promise<void> {
  const statements = migrationStatements(names, documents);
  await sql.begin(async (tx) => {
    for (const statement of statements) {
      await tx.unsafe(statement);
    }
  });
}
