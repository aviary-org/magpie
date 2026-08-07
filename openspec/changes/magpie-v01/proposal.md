## Why

Teams building event-sourced or document-oriented systems on Postgres today assemble a document layer, a hand-rolled event table, and custom projection logic per project — there is no single answer that gives them a document database *and* an event store with strong transactional consistency between the two. This change builds that missing artifact for TypeScript: a single library that uses Postgres as a document store, an event store, and one consistency boundary, without a second specialized database. The design is inspired by Marten, the .NET library that established this pattern.

The hard, worth-building-once part is not "store JSON in Postgres" — it is guaranteeing that documents, events, and projections stay correctly ordered and transactionally consistent across multiple app instances. That is the core of this library.

## What Changes

- **New package** `@aviary-org/magpie` — a TypeScript library for Postgres-as-document-store + Postgres-as-event-store, built around the *problem* rather than mirroring any single existing API surface.
- **Document store**: store/retrieve arbitrary application objects as JSONB per type (`magpie_doc_<alias>` tables), query by shape (filter/sort/paginate, nested field paths), optimistic concurrency via version, soft and hard delete.
- **Event store**: append events to named streams with strict per-stream ordering, stream-level optimistic concurrency, read full/partial history, and on-demand (live) aggregation by folding a stream's events.
- **Synchronous (inline) projections**: a fold definition, registered once, reused as live aggregation *or* persisted inline within the write transaction; projected state is queried through the document query surface.
- **Single-transaction consistency**: one logical operation can save documents and append events atomically; an inline projection reflects an event the moment the write is acknowledged.
- **Schema & contracts**: document and event shapes declared via Standard Schema (validator-agnostic — Zod, Valibot, ArkType, etc.), validated at ingestion, with explicit event-name-to-shape registration (no reflection-based discovery) and read-time upcasting for shape evolution.
- **v0.1 is a design-partner-grade release** (not production-completeness): async/background projections, multi-tenancy, multi-stream projections, and operational catch-up introspection are explicitly out of scope.

## Capabilities

### New Capabilities

- `document-store`: storing and querying application objects as JSONB, optimistic concurrency, soft/hard delete, shape evolution without immediate migration.
- `event-store`: appending events to streams with strict ordering and optimistic concurrency, reading history, and computing current state by folding a stream.
- `projections`: one fold definition reused across lifecycles — live (on demand, nothing persisted) and inline (persisted synchronously in the write transaction).
- `consistency`: a single Postgres transaction as the unit of work spanning documents and events, with correct behavior across multiple concurrent app instances.
- `schema-contracts`: Standard Schema-based shape definitions, validation timing rules, explicit event-name registration, and read-time upcasting.
- `operability`: explicit DDL bootstrap (`magpie migrate`) and backfill integrity validation (`magpie validate`). Async projection daemon, tenancy, and catch-up introspection are out of scope for v0.1.

### Modified Capabilities

None — `openspec/specs/` is empty; this is a greenfield library.

## Impact

- **New code**: entire library under a new `src/` tree in this repo; no existing code is modified.
- **New runtime dependency**: `postgres` (postgres-js), user-injected. `@standard-schema/spec` is a type-level dependency only.
- **New tooling**: `magpie migrate` (idempotent DDL) and `magpie validate <streamId|all>` (backfill integrity) CLIs.
- **Operations**: library tables live in a configurable Postgres schema (default `public`) under the fixed `magpie_` prefix; DDL is applied explicitly by the operator, never auto-created at runtime by default.
