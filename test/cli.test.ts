import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { createTestDatabase, type TestDatabase, testConfigFromEnv } from "./helpers/test-db.js";

let db: TestDatabase;
let configPath: string;
let databaseUrl: string;

beforeAll(async () => {
  db = await createTestDatabase();
  const config = testConfigFromEnv();
  databaseUrl = `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${db.databaseName}`;

  const dir = await mkdtemp(join(tmpdir(), "magpie-cli-"));
  configPath = join(dir, "magpie.config.mjs");
  await writeFile(
    configPath,
    [
      "export default (sql) => ({",
      "  migrate: async () => {",
      "    await sql`create table if not exists cli_probe (id integer primary key)`;",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
});

afterAll(async () => {
  await rm(configPath, { force: true });
  await rm(join(configPath, ".."), { recursive: true, force: true });
  await db.teardown();
});

describe("magpie migrate CLI", () => {
  it("runs migrate through the config module and connection string", async () => {
    const code = await main(["migrate", "--config", configPath, "--database-url", databaseUrl], {});
    expect(code).toBe(0);

    const rows = await db.sql`select to_regclass('public.cli_probe') as t`;
    expect(rows[0]?.t).not.toBeNull();
  });

  it("falls back to DATABASE_URL", async () => {
    const code = await main(["migrate", "--config", configPath], { DATABASE_URL: databaseUrl });
    expect(code).toBe(0);
  });

  it("supports --config=value and --database-url=value", async () => {
    const code = await main(
      ["migrate", `--config=${configPath}`, `--database-url=${databaseUrl}`],
      {},
    );
    expect(code).toBe(0);
  });

  it("prints usage and exits 0 for --help", async () => {
    const code = await main(["--help"], {});
    expect(code).toBe(0);
  });

  it("fails without a config", async () => {
    const code = await main(["migrate", "--database-url", databaseUrl], {});
    expect(code).toBe(1);
  });

  it("fails without a database url", async () => {
    const code = await main(["migrate", "--config", configPath], {});
    expect(code).toBe(1);
  });

  it("fails on unknown arguments", async () => {
    const code = await main(["migrate", "--bogus", configPath], {});
    expect(code).toBe(1);
  });

  it("fails when the config is not a module with a default export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "magpie-cli-bad-"));
    const badPath = join(dir, "bad.config.mjs");
    await writeFile(badPath, "export const notDefault = 42;\n");
    const code = await main(["migrate", "--config", badPath, "--database-url", databaseUrl], {});
    expect(code).toBe(1);
  });
});
