# Magpie

**Status: v0.1 implementation in progress.**

A single TypeScript library that turns Postgres into a **document store**, an **event store**, and one **consistency boundary** — the design is inspired by Marten, the .NET library that established this pattern. The goal is that a team building an event-sourced or document-heavy backend gets one dependency, one connection, and one mental model instead of assembling a document layer, a hand-rolled event table, and custom projection logic per project.

## What it does (v0.1 scope)

- **Document store** — save, retrieve, and query arbitrary application objects as JSONB (`magpie_doc_<alias>` tables, one per type), with nested-field filtering, sorting, offset pagination, optimistic concurrency, and soft/hard delete.
- **Event store** — append immutable events to named streams with strict per-stream ordering and stream-level optimistic concurrency; read full or partial history; fold a stream's events into current state on demand.
- **One transaction** — a single Postgres transaction is the unit of work spanning documents, event appends, and inline projections, all-or-nothing.
- **Inline projections** — one fold definition, reused live (on demand, unpersisted) and inline (persisted in the same transaction as the write). Projected output is stored and queried like a document.
- **Standard Schema shapes** — document and event shapes declared with any Standard Schema-compatible validator (Zod, Valibot, ArkType, …), validated at ingestion; no reflection-based discovery.
- **Read-time upcasting** — shapes evolve across versions by transforming old stored rows at read time, never rewriting history.

## Non-goals (v0.1)

Async/background projections and the projection daemon, multi-tenancy, multi-stream projections, catch-up/lag introspection, and non-Postgres databases.

## Design

- Per-type tables in a configurable schema, `bigint` version columns on documents and streams, projection snapshots versioned from the stream version.
- `postgres` (postgres-js) as the single injected driver; no driver abstraction.
- Validator-agnostic storage metadata: per-field casts and indexes expressed alongside the schema, with sensible defaults (`number`→`numeric`, `boolean`, `Date`→`timestamptz`, `bigint`, `string`).
- Event schema versions baked into stored names (e.g. `order_completed_v2`); upcasters transform old shapes at read time, before any fold or read logic.
- A callback session as the unit of work — one transaction wraps document saves, event appends, and inline projection updates; `expectedVersion` expresses optimistic-concurrency intent (`"any"` bypasses the check for documents).
- Offset pagination (`limit`/`offset`), not cursors.
- Explicit, idempotent DDL via `store.migrate()` / `magpie migrate`; no auto-DDL at runtime by default (opt-in `autoCreate: true` for dev).

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
