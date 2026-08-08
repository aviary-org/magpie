## Context

Greenfield TypeScript library (`@aviary-org/magpie`) in this repo; no existing source code. The library turns Postgres into a document store + event store with one consistency boundary. Motivation and scope: see proposal.md — Why and v0.1 scope.

Grounding facts that shape this design: per-document-type tables (`magpie_doc_<alias>`), a global event sequence via a Postgres `SEQUENCE`, `(stream_id, version)` uniqueness as the append-time concurrency backstop, inline projections persisted into the same document tables as hand-saved docs, projection snapshots sourcing their version from the stream version, advisory locks used *only* by async daemon infrastructure (never inline work), and lazily auto-created DDL as the historical default.

Key constraint: TypeScript erases types at runtime, so the static-language approach of deriving cast/column types from declared types has no TS equivalent. This forces explicit registration where a static-typed language would get it for free — the one place the design deliberately deviates.

## Goals / Non-Goals

**Goals:**
- Single Postgres connection (`postgres` postgres-js) backing documents, events, and projections.
- One fold definition reused across `live` and `inline` lifecycles.
- Explicit, validator-agnostic shape + storage registration with no reflection.
- All-or-nothing document+event writes in one Postgres transaction, inline projections included.
- Design-partner-grade v0.1: correct, testable, documented; not yet production-hardened.

**Non-Goals (v0.1):**
- Async/background projections and the projection daemon (advisory-lock coordination, high-water marks, multi-instance daemon safety) — deferred, but the append/stream schema is chosen so it can be added without restructuring.
- Multi-tenancy; multi-stream projections; catch-up/lag introspection.
- Driver-agnostic abstraction beyond postgres-js (adapters can come later behind a thin interface).
- Multi-stage upcast chains ("one event splits into two").

## Decisions

### D1. Storage layout: per-type document tables in a configurable schema

One Postgres table per registered document type, named `magpie_doc_<alias>`, living in a configurable schema (default `public`). Event storage is a fixed set of tables (`magpie_events`, `magpie_streams`, plus a `magpie_events_sequence` `SEQUENCE` for the global event id) and helper functions (`magpie_quick_append_events`, `magpie_immutable_timestamp*`). All names share the fixed `magpie_` prefix; the schema name is the one knob that moves everything at once (e.g. `createStore({ sql, schema: "magpie" })`).

**Why:** One table per type (a proven layout) enables per-type duplicated index columns and tight scans. The prefix is fixed rather than configurable to avoid threading a configurable name through every generated DDL reference (functions reference tables by name); the schema name covers multi-instance/multi-tenant-in-same-DB needs. Bare `doc_<alias>` or `<alias>` was rejected for collision risk and non-discoverability of table ownership.

### D2. Document version: `bigint` revision everywhere

All documents (hand-saved and projection snapshots) use a single `bigint` version column:
- Hand-saved docs: `set version = version + 1 where id = ? and version = ?` — zero rows affected → concurrency error.
- Deletes: soft delete flips `deleted`/`deleted_at` without advancing the version (a delete is not a data revision); a later save — carrying the pre-delete version or `"any"` — resurrects the row by resetting the flags. Hard delete removes the row.
- Inline projection snapshots: version sourced from the stream's current version via a subquery (`COALESCE((select version from magpie_streams where id = ...), fallback)`); the guard is `where ? = 0 or stream_version <= ?` when an expected version is supplied. The snapshot's version literally means "the stream version this snapshot reflects".

**Why:** Two physical modes exist (uuid optimistic tokens, long revisions); projection documents are forced into revision mode by policy, because a snapshot's version naturally means "the stream version this snapshot reflects". Unifying on `bigint` gives one SQL pattern, one mental model. The version value is opaque in the typed API (read it, hand it back), so the wire type is invisible to users. If a uuid-etag mode is ever needed post-v0.1 (e.g. async rebuilds wanting non-monotonic tokens), it is additive: a new optional column, never a migration of existing rows.

### D3. DDL bootstrap: explicit and idempotent, with opt-in auto-create

No auto-DDL by default. `await store.migrate()` (and a `magpie migrate` CLI) applies all registered schema idempotently (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `CREATE SEQUENCE IF NOT EXISTS`). `createStore({ autoCreate: true })` re-enables lazy auto-create for dev/test.

**Why:** Lazy auto-create was the historical default; modern Node ops (Prisma, drizzle, Kysely) default to explicit migrations with CLIs. Surprise DDL against production Postgres is the footgun. The divergence is deliberate and cheap — it is a default, not an architecture change.

### D4. Driver: `postgres` (postgres-js), user-injected

`createStore({ sql })` takes a user-owned postgres-js instance; the library composes with `sql.begin(...)`, template-tagged queries, and parameterized statements. Users who want drizzle for their own relational tables can wrap the same `postgres` instance (`drizzle(sql)`), sharing one pool.

**Why:** drizzle-orm's JSONB column is opaque (no path accessors, no JSONB operators — everything interesting is raw `sql` fragments anyway), and its result typing is HKT-coupled, so wrapping it buys little for this library. postgres-js is the cleanest template-tagged SQL surface for the JSONB/`nextval`/`@>` work ahead. Deferred: a thin driver interface + node-postgres adapter once the API is stable.

### D5. Query surface: typed field paths + operator methods

`store.path<T>()` returns a typed handle over the schema's inferred output type: `$.address.city.eq("Boston")`, `$.balance.gte(100)`, composed with `and(...)` / `or(...)`, sorted by `$.updatedAt.desc()`, paginated `.limit(n).offset(n)`.

Leaf operators: `eq`, `ne`, `lt`, `gt`, `lte`, `gte`, `in`, `isNull`, `notNull`, `startsWith`, `endsWith`, `contains` (JSONB containment via `@>`), `between`. Nested traversal uses `->` to descend (jsonb kept), `->>` at the leaf (text), and `CAST(... as <pgType>)` for typed/range comparisons — the proven translation pattern (`CAST(data ->> 'Age' as integer)`).

**Why:** validator-agnostic (built from Standard Schema's inferred output type, not validator internals); no expression-tree capture is possible in TS (reflection gap), so filters are built explicitly — but the explicit form is still type-checked against the schema. Object-shape filters (`{ address: { city: ... } }`) rejected: breaks down for ranges. Raw SQL fragments rejected: loses typed field names. Pagination stays offset-based (`limit`/`offset`) — a deliberate choice, not a v0.1 shortcut; cursor-based pagination remains a possible future enhancement.

### D6. Field casts: default map + per-field overrides in the document config callback

Standard Schema covers shape/validation only; storage metadata (id field, casts, indexes, tenancy later) lives in a separate validator-agnostic registration. The document registration callback is the single surface for both storage metadata and indexes:

```ts
store.document(AccountSchema, (t) => ({
  fields: [
    t.path.id.cast("uuid").primaryKey(),
    t.path.balance.cast("numeric").index(),
    t.path.updatedAt.cast("timestamptz").index(),   // uses immutable wrapper
    t.path.tags.containsIndex(),                     // GIN @> index
  ],
}));
```

Default casts apply when a field is not mentioned: `number → numeric`, `boolean → boolean`, `Date → timestamptz` (via wrapper function), `bigint → bigint`, `string →` (no cast). Because TS has no runtime types, the *cast choice itself* must be user-expressible — this is the one place the design is deliberately more explicit than a static-typed design would need to be, where inline casts are derived from declared types and per-field overrides exist only for duplicated columns.

Date/UUID/numeric comparisons go through immutable PL/pgSQL wrapper functions (`magpie_immutable_timestamptz`, etc.) rather than plain `CAST(... as timestamptz)`, because Postgres cannot index a non-immutable cast of `jsonb ->>` output; the wrapper-function approach is the proven answer to that.

### D7. Event identity: schema version baked into the stored name

No per-event schema-version column. The stored `type` column carries the versioned name (`order_completed_v2`). Registrations:
- `store.event("order_completed", schemaV1)` and `store.event("order_completed_v2", schemaV2)` declare shapes.
- `store.upcaster("order_completed", (old) => upcast(old))` transforms old-name rows to the current shape at read time.
- `store.stream("order", { events: [...] })` defines the write-time contract of allowed events; `store.aggregate(stream, AccountSchema, fold)` references a stream and defines read-time fold logic.

Upcasters are keyed by stored name; each row maps to exactly one upcaster (no multi-stage chains in v0.1) — the proven design for this problem. Upcasting runs at the single event-deserialization chokepoint, before any fold or read logic. At that chokepoint an upcaster keyed by the stored name runs first when registered, and its output is validated against the shape registered under that stored name — the current shape — so evolving an event means registering the current shape under the old stored name (plus a versioned name for new appends) alongside the upcaster. Rows without an upcaster are returned as stored: ingestion already validated them, and reads never re-validate.

### D8. Unit of work: explicit callback session

```ts
await store.session(async (s) => {
  await s.documents.save(account);
  await s.events.append(account.id, [statusChanged]);
  // throw to rollback; return to commit
});
// s.session(async (sp) => ...) → savepoint; s.rollback() → typed sentinel
```

No ambient context (AsyncLocalStorage), no `using`/`Symbol.dispose` resource handle in v0.1. One session = one Postgres transaction; the callback makes the boundary explicit and unmissable, matching drizzle's tested pattern and postgres-js's `sql.begin`.

### D9. Optimistic concurrency API

- Documents: save with the expected version read from the loaded document; mismatch → concurrency error. Explicit bypass: `expectedVersion: "any"` → unconditional upsert (`ON CONFLICT (id) DO UPDATE`, no version guard), version still advances. Projection snapshots: no bypass; version always sourced from the stream.
- Events: append with expected stream version. `append(streamId, events)` auto-creates the stream if missing; `{ expectedVersion: 0 }` requires it not exist; `{ expectedVersion: N }` requires it at version N. Mismatch → concurrency error, nothing written. The append path checks the stream version before inserting — v0.1 does this with a per-stream row lock (`SELECT ... FOR UPDATE`), the same exactly-one-winner guarantee as a server-side guard function without the extra DDL artifact — with `(stream_id, version)` uniqueness as the database backstop, raising a typed error on version mismatch.

### D10. Snapshot row ownership: document, don't enforce

Hand-saving a document whose id is also an inline-projection output is not detected or prevented by the reference design; a daemon rebuild *truncates* the projection's snapshot table, and continuous daemon writes overwrite with no exception. This design follows suit: no runtime ownership check, but the behavior is documented prominently — a rebuild destroys hand-saved rows in projection-output tables, and app hand-saves of a snapshot-owned id are operator responsibility. A config-time warning is considered acceptable lint (registering the same schema both ways), not a guard.

**Why not enforce:** a per-id runtime check cannot work across app instances (instance B does not know instance A projected id X), so partial enforcement is worse than honest "not enforced". Matches the proven "trust the user" stance.

### D11. Backfill validation: `magpie validate <streamId|all>`

A read-only CLI/admin op that scans every event row (or every row of a document type), applies registered upcasters first, validates each row against the currently registered shape, and reports mismatches (row id, type, validation issues) with a non-zero exit on failure. It never writes. It closes the "imported data was never validated" hole without paying re-validation cost on the hot read path (schema-contracts: validation timing).

## Risks / Trade-offs

- **One driver dependency (postgres-js) in v0.1** → narrows the "who can adopt" surface; mitigation: user injects the `sql` instance (their pool, their choice) and a driver interface is deferred, not foreclosed.
- **Explicit per-field cast registration is novel relative to static-typed designs** → some users will forget a cast and get text comparisons on a numeric field; mitigation: default casts cover the common cases, and index creation (`cast("numeric").index()`) surfaces the type at DDL time.
- **Server-side append guard would be a DDL artifact to manage** → avoided in v0.1 by the row-lock equivalent, which needs no function; if a function-based guard is ever added, idempotent `CREATE OR REPLACE` keeps `migrate()` re-runnable.
- **`bigint` versions are monotonic per row/stream** → fine for v0.1's OCC; uuid-etag mode, if ever needed, is additive (new column), not a migration.
- **No async projections means operators self-manage catch-up** → explicitly out of scope for v0.1 (design-partner grade); schema choices (global event sequence, per-stream versions, snapshot version = stream version) keep the door open without restructuring.
- **Rebuild truncation of snapshot tables (reference behavior, inherited)** → operator-visible data loss if hand-saved rows live in projection tables; mitigation: documented in D10, plus the config-time warning.

## Migration Plan

Greenfield: no existing schema or data to migrate. The `magpie migrate` operation is the forward path; each library release can add idempotent schema steps for any new columns/functions it introduces. Rollback for v0.1 = drop the `magpie_`-prefixed objects (documented `magpie teardown` guidance, not a CLI in v0.1).

## Open Questions

- None that would change the specs, the approach, or the task breakdown. Decisions deferred to post-v0.1 (async daemon design, multi-stream aggregation, multi-tenancy, driver adapters, cursor pagination, multi-stage upcast chains) are scoped out, not unknown.
