import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  testConfigFromEnv,
  type TestDatabase,
} from "./helpers/test-db.js";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.teardown();
});

describe("test database harness", () => {
  it("runs queries against the isolated database", async () => {
    const rows = await db.sql`select 1 as n`;
    expect(rows[0]).toEqual({ n: 1 });
  });

  it("round-trips DDL and rows", async () => {
    await db.sql`create table widget (id integer primary key, name text)`;
    await db.sql`insert into widget (id, name) values (1, 'a'), (2, 'b')`;
    const rows = await db.sql`select * from widget order by id`;
    expect(rows).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
  });

  it("gives each run its own database", async () => {
    const second = await createTestDatabase();
    expect(second.databaseName).not.toBe(db.databaseName);
    await second.teardown();
  });

  it("drops the database on teardown", async () => {
    const second = await createTestDatabase();
    const admin = postgres({ ...testConfigFromEnv(), database: "postgres", max: 1 });
    const before = await admin`select 1 from pg_database where datname = ${second.databaseName}`;
    expect(before.length).toBe(1);
    await second.teardown();
    const after = await admin`select 1 from pg_database where datname = ${second.databaseName}`;
    expect(after.length).toBe(0);
    await admin.end();
  });
});
