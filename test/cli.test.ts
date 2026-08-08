import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formatValidateReport, main, reportJson } from "../src/cli.js";
import type { ValidationReport } from "../src/index.js";
import { createTestDatabase, type TestDatabase, testConfigFromEnv } from "./helpers/test-db.js";

let db: TestDatabase;
let configPath: string;
let validateConfigPath: string;
let noValidateConfigPath: string;
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

  validateConfigPath = join(dir, "magpie.validate.config.mjs");
  await writeFile(
    validateConfigPath,
    [
      "export default () => ({",
      "  migrate: async () => {},",
      "  validate: async ({ streamId, documents }) => {",
      "    const mismatches =",
      "      streamId === 'order-9'",
      "        ? [{ kind: 'event', id: 3n, streamId: 'order-9', version: 1n, type: 'order_placed', issues: [{ message: 'order_placed: invalid payload' }] }]",
      "        : [];",
      "    return { events: streamId === undefined ? 5 : 1, documents: documents ? 2 : 0, mismatches };",
      "  },",
      "});",
      "",
    ].join("\n"),
  );

  noValidateConfigPath = join(dir, "magpie.novalidate.config.mjs");
  await writeFile(
    noValidateConfigPath,
    ["export default () => ({ migrate: async () => {} });", ""].join("\n"),
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

describe("magpie validate CLI", () => {
  it("scans every stream and exits 0 on clean data", async () => {
    const code = await main(
      ["validate", "--config", validateConfigPath, "--database-url", databaseUrl],
      {},
    );
    expect(code).toBe(0);
  });

  it("treats the literal target all like every stream", async () => {
    const code = await main(
      ["validate", "all", "--config", validateConfigPath, "--database-url", databaseUrl],
      {},
    );
    expect(code).toBe(0);
  });

  it("exits 1 when the targeted stream has mismatches", async () => {
    const code = await main(
      ["validate", "order-9", "--config", validateConfigPath, "--database-url", databaseUrl],
      {},
    );
    expect(code).toBe(1);
  });

  it("exits 0 for a stream without mismatches", async () => {
    const code = await main(
      ["validate", "order-1", "--config", validateConfigPath, "--database-url", databaseUrl],
      {},
    );
    expect(code).toBe(0);
  });

  it("passes the documents flag through", async () => {
    const code = await main(
      [
        "validate",
        "order-9",
        "--documents",
        "--config",
        validateConfigPath,
        "--database-url",
        databaseUrl,
      ],
      {},
    );
    expect(code).toBe(1);
  });

  it("emits JSON with --json and exits 1 on mismatches", async () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      const code = await main(
        [
          "validate",
          "order-9",
          "--json",
          "--config",
          validateConfigPath,
          "--database-url",
          databaseUrl,
        ],
        {},
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(writes.join("")) as {
        readonly mismatches: readonly { readonly kind: string }[];
      };
      expect(parsed.mismatches).toHaveLength(1);
      expect(parsed.mismatches[0]?.kind).toBe("event");
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects validate-only flags on migrate", async () => {
    const code = await main(
      ["migrate", "--documents", "--config", configPath, "--database-url", databaseUrl],
      {},
    );
    expect(code).toBe(1);
  });

  it("fails when the store lacks validate", async () => {
    const code = await main(
      ["validate", "--config", noValidateConfigPath, "--database-url", databaseUrl],
      {},
    );
    expect(code).toBe(1);
  });

  it("rejects an unknown command", async () => {
    const code = await main(["bogus", "--config", configPath, "--database-url", databaseUrl], {});
    expect(code).toBe(1);
  });
});

describe("validate report formatting", () => {
  it("formats mismatches with their identifiers and issue paths", () => {
    const report: ValidationReport = {
      events: 2,
      documents: 1,
      mismatches: [
        {
          kind: "event",
          id: 7n,
          streamId: "order-9",
          version: 1n,
          type: "order_placed",
          issues: [{ message: "order_placed: invalid payload", path: ["amount"] }],
        },
        {
          kind: "document",
          id: "acct-2",
          type: "account",
          issues: [{ message: "account: invalid payload" }],
        },
      ],
    };

    const text = formatValidateReport(report);
    expect(text).toContain("scanned 2 event rows, 1 document rows; 2 mismatches");
    expect(text).toContain(
      "event order_placed at stream order-9 version 1: order_placed: invalid payload (at amount)",
    );
    expect(text).toContain("document account id acct-2: account: invalid payload");
  });

  it("serializes bigint identifiers as strings in JSON", () => {
    const report: ValidationReport = {
      events: 1,
      documents: 0,
      mismatches: [
        {
          kind: "event",
          id: 7n,
          streamId: "order-9",
          version: 1n,
          type: "order_placed",
          issues: [{ message: "boom" }],
        },
      ],
    };

    const parsed = JSON.parse(reportJson(report)) as {
      readonly mismatches: readonly { readonly id: unknown; readonly version: unknown }[];
    };
    expect(parsed.mismatches[0]?.id).toBe("7");
    expect(parsed.mismatches[0]?.version).toBe("1");
  });
});
