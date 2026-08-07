import { randomBytes } from "node:crypto";
import postgres, { type Sql } from "postgres";

/** Connection settings for the local test Postgres; mirror the docker-compose defaults. */
export interface TestDatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
}

/** An isolated Postgres database created for one test run. */
export interface TestDatabase {
  /** Postgres client bound to the isolated database. */
  readonly sql: Sql;
  readonly databaseName: string;
  /** Closes the client and drops the database. */
  teardown(): Promise<void>;
}

const DEFAULT_CONFIG: TestDatabaseConfig = {
  host: "localhost",
  port: 5432,
  user: "magpie",
  password: "magpie",
};

/** Connection settings for the local test Postgres, resolved from `MAGPIE_TEST_*` env vars. */
export function testConfigFromEnv(): TestDatabaseConfig {
  const portValue = process.env.MAGPIE_TEST_PORT;
  const port = portValue === undefined ? DEFAULT_CONFIG.port : Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`MAGPIE_TEST_PORT must be a port between 1 and 65535, got "${portValue}"`);
  }
  return {
    host: process.env.MAGPIE_TEST_HOST ?? DEFAULT_CONFIG.host,
    port,
    user: process.env.MAGPIE_TEST_USER ?? DEFAULT_CONFIG.user,
    password: process.env.MAGPIE_TEST_PASSWORD ?? DEFAULT_CONFIG.password,
  };
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const config = testConfigFromEnv();
  const databaseName = `magpie_test_${randomBytes(8).toString("hex")}`;
  // The name is generated hex-only, so inlining it into DDL is safe; postgres-js has no identifier helper.
  const admin = postgres({ ...config, database: "postgres", max: 1 });
  try {
    await admin.unsafe(`create database "${databaseName}"`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const sql = postgres({ ...config, database: databaseName });
  return {
    sql,
    databaseName,
    async teardown() {
      await sql.end();
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end();
    },
  };
}
