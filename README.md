# Magpie

**Status: v0.1**

A single TypeScript library that turns Postgres into a **document store**, an **event store**, and one **consistency boundary** — the design is inspired by Marten, the .NET library that established this pattern. The goal is that a team building an event-sourced or document-heavy backend gets one dependency, one connection, and one mental model instead of assembling a document layer, a hand-rolled event table, and custom projection logic per project.

## Quick start

```bash
pnpm add @aviary-org/magpie postgres
```

Shapes are declared with any validator that conforms to [Standard Schema](https://github.com/standard-schema/standard-schema) — Zod, Valibot, ArkType, and others work the same way. The examples below use Zod.

```ts
import postgres from "postgres";
import { z } from "zod";
import { createStore, type StoredEvent } from "@aviary-org/magpie";

const sql = postgres(process.env.DATABASE_URL);
const store = createStore({ sql }); // or createStore({ sql, schema: "magpie" })

// --- Shapes (Standard Schema) ---
const accountSchema = z.object({ id: z.string(), balance: z.number() });
type Account = z.infer<typeof accountSchema>;

const orderPlacedSchema = z.object({ orderId: z.string(), amount: z.number() });
type OrderPlaced = z.infer<typeof orderPlacedSchema>;

const orderStateSchema = z.object({ orderId: z.string(), total: z.number() });
type OrderState = z.infer<typeof orderStateSchema>;

// --- Registration ---
// Storage metadata (id field, casts, indexes) is a separate surface, never merged
// into the schema. The table alias defaults to the schema's name; pass `name`
// when the validator does not carry a usable one (Zod objects do not).
store.document(accountSchema, (t) => ({
  name: "account",
  fields: [
    t.path.id.cast("text").primaryKey(),
    t.path.balance.cast("numeric").index(),
  ],
}));

store.event("order_placed", orderPlacedSchema);
store.stream("order", { events: ["order_placed"] });
store.aggregate(
  "order",
  orderStateSchema,
  (state, event) => {
    const current = (state ?? { orderId: "", total: 0 }) as OrderState;
    const stored = event as StoredEvent;
    if (stored.type === "order_placed") {
      const placed = stored.data as OrderPlaced;
      return { orderId: placed.orderId, total: current.total + placed.amount };
    }
    return current;
  },
  { inline: true },
);

// --- DDL: explicit and idempotent, safe to re-run ---
await store.migrate();

// --- Write: one transaction, all-or-nothing ---
await store.session(async (s) => {
  await s.documents.save(accountSchema, { id: "acct-1", balance: 100 });
  await s.events.append("order-1", [
    { type: "order_placed", data: { orderId: "order-1", amount: 25 } },
  ]);
});

// --- Read ---
const account = await store.load(accountSchema, "acct-1"); // { data, version }

// --- Query ---
const $ = store.path<Account>();
const rows = await store
  .query(accountSchema)
  .where($.balance.gte(50))
  .orderBy($.balance.desc())
  .limit(10)
  .toArray();
```

Optimistic concurrency is explicit: pass the version read from a load back to the next save, or use `"any"` to write unconditionally.

```ts
if (account !== undefined) {
  await store.session(async (s) => {
    await s.documents.save(
      accountSchema,
      { ...account.data, balance: account.data.balance + 10 },
      { expectedVersion: account.version },
    );
  });
}
```

## What it does (v0.1 scope)

- **Document store** — save, retrieve, and query arbitrary application objects as JSONB (`magpie_doc_<alias>` tables, one per type), with nested-field filtering, sorting, offset pagination, optimistic concurrency, and soft/hard delete.
- **Event store** — append immutable events to named streams with strict per-stream ordering and stream-level optimistic concurrency; read full or partial history; fold a stream's events into current state on demand.
- **One transaction** — a single Postgres transaction is the unit of work spanning documents, event appends, and inline projections, all-or-nothing.
- **Inline projections** — one fold definition, reused live (on demand, unpersisted) and inline (persisted in the same transaction as the write). Projected output is stored and queried like a document.
- **Standard Schema shapes** — document and event shapes declared with any Standard Schema-compatible validator, validated at ingestion; no reflection-based discovery.
- **Read-time upcasting** — shapes evolve across versions by transforming old stored rows at read time, never rewriting history.

## Design

- Per-type tables in a configurable schema, `bigint` version columns on documents and streams, projection snapshots versioned from the stream version.
- `postgres` (postgres-js) as the single injected driver; no driver abstraction.
- Validator-agnostic storage metadata: per-field casts and indexes expressed alongside the schema, with sensible defaults (`number`→`numeric`, `boolean`, `Date`→`timestamptz`, `bigint`, `string`).
- Event schema versions baked into stored names (e.g. `order_completed_v2`); upcasters transform old shapes at read time, before any fold or read logic.
- A callback session as the unit of work — one transaction wraps document saves, event appends, and inline projection updates; `expectedVersion` expresses optimistic-concurrency intent (`"any"` bypasses the check for documents).
- Offset pagination (`limit`/`offset`), not cursors.
- Explicit, idempotent DDL via `store.migrate()` / `magpie migrate`; no auto-DDL at runtime by default (opt-in `autoCreate: true` for dev).

## Inline projection snapshot rows

An inline aggregate's snapshot rows live in the same document tables as hand-saved documents, keyed by the stream id. Two ownership rules follow:

- **A rebuild truncates the projection table.** Rebuilding an inline projection (dropping and re-applying it) destroys every hand-saved row in that table. Keep hand-saved data in separate document types.
- **Hand-saving a snapshot-owned id is not detected.** The library does not check at runtime whether the id you are saving belongs to an inline projection; a later append simply overwrites the snapshot. Whether to hand-save into a snapshot table is operator responsibility.

## Validation timing and the backfill contract

Validation runs at ingestion only:

- Documents are validated when saved; events are validated when appended.
- Reads, folds, and replays never re-validate stored data — data was already validated when written.
- Upcaster output is the one exception: upcasters are hand-written transforms, so their output is validated against the current shape before any fold or read logic sees it.

The flip side: **data that was not written through the store was never validated.** Importing or backfilling event or document rows behind the library's back leaves them unchecked on the hot path. Before pointing an app at imported data, run the backfill check:

```bash
magpie validate all --config ./magpie.config.mjs
```

The scan is read-only: it upcasts first, validates every row against the registered shapes, and reports each mismatch with its row identifiers and validation issues, exiting non-zero when anything fails. It also accepts a single stream id, `--documents` to include document rows, and `--json` for automation. The same scan is available in code as `store.validate()`.

## Operability

Schema is applied explicitly by the operator, never auto-created at runtime by default. The CLI loads whatever module you point it at with `--config` (there is no config-file discovery); the module must export a default `(sql) => Store` function. The CLI passes the connection in, so the module only registers:

```js
// magpie.config.mjs
import { z } from "zod";
import { createStore } from "@aviary-org/magpie";

export default (sql) => {
  const store = createStore({ sql });

  const accountSchema = z.object({ id: z.string(), balance: z.number() });
  store.document(accountSchema, (t) => ({
    name: "account",
    fields: [
      t.path.id.cast("text").primaryKey(),
      t.path.balance.cast("numeric").index(),
    ],
  }));

  const orderPlacedSchema = z.object({ orderId: z.string(), amount: z.number() });
  store.event("order_placed", orderPlacedSchema);
  store.stream("order", { events: ["order_placed"] });

  return store;
};
```

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/app \
  magpie migrate --config ./magpie.config.mjs    # idempotent DDL

DATABASE_URL=postgres://user:pass@localhost:5432/app \
  magpie validate all --config ./magpie.config.mjs --documents
```

Re-running migrate is safe. A full teardown means dropping the `magpie_`-prefixed objects.

## Not in v0.1

These are deliberately deferred:

- **Async/background projections** and the projection daemon (advisory-lock coordination, high-water marks, multi-instance safety). The event and stream schema is chosen so it can be added without restructuring.
- **Multi-tenancy** (beyond a configurable Postgres schema) and **multi-stream projections** (one projection fed by several streams).
- **Driver adapters** — only postgres-js in v0.1, injected by the caller.
- **Cursor pagination** — offset pagination (`limit`/`offset`) only.
- **Multi-stage upcast chains** — one stored event maps to at most one upcaster.

## Repository layout

```
src/                 library source (entry point: src/index.ts)
test/                Vitest suite (integration tests need the local Postgres)
.agents/skills/       agent skills
```

## Development

The package manager is **pnpm** (`^11.5.3`); the package is ESM (`"type": "module"`) and requires Node >= 20.

```bash
pnpm install
pnpm lint          # Biome check
pnpm typecheck     # tsc --noEmit
pnpm test          # Vitest; integration tests need `docker compose up -d`
pnpm build         # tsup → dist/
```

## License

MIT
