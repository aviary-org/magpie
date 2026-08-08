## 1. Project scaffold

- [x] 1.1 Initialize TypeScript project: `package.json` (name `@aviary-org/magpie`, ESM), `tsconfig.json` (strict), build config for library output
- [x] 1.2 Add dependencies: `postgres` (runtime), `@standard-schema/spec` (type-level), Vitest (test)
- [x] 1.3 Set up test harness: Vitest config, `docker-compose.yml` for a local Postgres test database, test helper that creates an isolated database per test run

## 2. Registration core

- [x] 2.1 Implement `createStore({ sql, schema, autoCreate })` and the `Store` surface that holds registrations
- [x] 2.2 Implement Standard Schema resolution helper: `validateWith(schema, data)` returning typed issues, and type-level `SchemaOutput<T>` extraction from `~standard.types.output`
- [x] 2.3 Implement `store.document(schema, config?)` registration: alias derivation from schema/name, storage metadata surface (`fields`, id field) per design D6
- [x] 2.4 Implement `store.event(name, schema)` and `store.stream(name, { events })` registrations with the write-time event contract
- [x] 2.5 Implement `store.upcaster(name, fn)` registration keyed by stored event name, and `store.aggregate(stream, schema, fold)` registration referencing a stream
- [x] 2.6 Implement registration validation: duplicate names, stream referencing unknown event names, unknown aliases — all rejected at registration time

## 3. Storage layout and DDL

- [x] 3.1 Implement the table/sequence naming module (`magpie_` prefix, configurable schema, `magpie_doc_<alias>` convention)
- [x] 3.2 Implement DDL generation for a document table: `id`, `version` (bigint), `data` (jsonb), `last_modified`, `deleted`, `deleted_at`, plus per-field duplicated index columns (design D2, D6)
- [x] 3.3 Implement DDL for event storage: `magpie_events` (id, stream_id, version, type, data, timestamp), `magpie_streams` (id, version, type), `magpie_events_sequence` with `(stream_id, version)` unique index
- [x] 3.4 Implement `store.migrate()`: idempotent apply of all registered schema (`IF NOT EXISTS` variants), plus `autoCreate: true` lazy path
- [x] 3.5 Implement the immutable cast wrapper functions (`magpie_immutable_timestamptz`, `magpie_immutable_timestamp`, `magpie_immutable_date`) in `migrate()` output
- [x] 3.6 Implement `magpie migrate` CLI (reads config, runs migrate against the connection string)

## 4. Unit of work / session

- [x] 4.1 Implement `store.session(async s => ...)` using `sql.begin`, with `s.documents` and `s.events` handles scoped to the transaction
- [x] 4.2 Implement nested sessions as savepoints and `s.rollback()` typed sentinel (design D8)
- [x] 4.3 Implement the session's write queue: buffered document saves and event appends flushed atomically at session end

## 5. Document store

- [x] 5.1 Implement save: upsert with `version + 1` and `where id = ? and version = ?` guard, returning the new version; zero rows → concurrency error (design D2)
- [x] 5.2 Implement `expectedVersion: "any"` bypass: unconditional `ON CONFLICT (id) DO UPDATE`, version still advances (design D9)
- [x] 5.3 Implement load by id with absence-as-nothing semantics; load by id + expected version
- [x] 5.4 Implement soft delete (set `deleted`, `deleted_at`; excluded from reads) and hard delete (row removal) (design D1)
- [x] 5.5 Implement save-time validation against the registered schema; invalid documents rejected with issues before any SQL

## 6. Query engine

- [x] 6.1 Implement `store.path<T>()` typed field-path builder over the schema's inferred output type, with nested traversal through objects (design D5)
- [x] 6.2 Implement leaf operators (`eq`, `ne`, `lt`, `gt`, `lte`, `gte`, `in`, `isNull`, `notNull`, `startsWith`, `endsWith`, `contains`, `between`) and `and`/`or` composition
- [x] 6.3 Implement SQL translation: `->` descent, `->>` leaf, `CAST(... as <pgType>)` for typed comparisons, `@>` for containment (design D5)
- [x] 6.4 Implement the default cast map (number→numeric, boolean→boolean, Date→timestamptz via wrapper, bigint→bigint, string→no cast) (design D6)
- [x] 6.5 Implement per-field cast overrides via the document config callback (`t.path.x.cast("uuid")`) (design D6)
- [x] 6.6 Implement query execution: `query(schema).where(...).orderBy(...).limit(n).offset(n).toArray()`, with filters translated and bound over the transaction or store
- [x] 6.7 Implement duplicated index columns and GIN `containsIndex()` DDL from the config callback (design D1, D6)

## 7. Event store

- [ ] 7.1 Implement `s.events.append(streamId, events)` with auto-create for missing streams; `expectedVersion: 0` and `expectedVersion: N` semantics (design D9)
- [ ] 7.2 Implement append-time validation of event payloads against the registered event schema; unregistered event names rejected
- [ ] 7.3 Implement the append SQL path: stream version check before insert (server-side `magpie_quick_append_events` function or equivalent), `(stream_id, version)` unique backstop, stream version bump (design D9)
- [ ] 7.4 Implement global event sequence allocation via `magpie_events_sequence`
- [ ] 7.5 Implement read stream history (full and from-version slices, in order) with upcasting applied at the deserialization chokepoint (design D7)
- [ ] 7.6 Implement on-demand aggregation: fold a stream's events with the registered fold definition, absent-stream → nothing (design D7)

## 8. Inline projections

- [ ] 8.1 Implement the shared fold-definition model reused by live and inline lifecycles (design D7)
- [ ] 8.2 Implement inline projection application: on session commit, for each affected stream, load the current snapshot row, fold new events, write back with version sourced from the stream's version (design D2)
- [ ] 8.3 Ensure inline projection writes are queued in the same session transaction as the event appends (consistency spec)
- [ ] 8.4 Implement snapshot queryability: projected rows retrievable through the document query surface (design D1)

## 9. Consistency and concurrency

- [ ] 9.1 Integration tests: concurrent appends to the same stream from parallel sessions — exactly one wins per version (consistency spec)
- [ ] 9.2 Integration tests: concurrent saves of the same document — exactly one wins; `expectedVersion: "any"` bypass succeeds
- [ ] 9.3 Integration tests: document + event in one session commit atomically; forced failure rolls back both
- [ ] 9.4 Integration tests: inline projection reflects the event at write-acknowledged time; failed write leaves projection unchanged

## 10. Operability tooling

- [ ] 10.1 Implement `magpie validate <streamId|all>`: read-only scan of event rows (and optionally document types), upcast first, validate against registered shapes, report mismatches with row ids and issues, non-zero exit on failure (design D11)
- [ ] 10.2 Implement `--json` output for the validate command for automation

## 11. Documentation

- [ ] 11.1 README: quick start (connection, register, migrate, save/append/query), v0.1 scope statement
- [ ] 11.2 Document snapshot-row ownership: rebuild truncates projection tables; hand-saving a snapshot-owned id is operator responsibility (design D10)
- [ ] 11.3 Document validation timing (ingestion always; no re-validation on reads; upcaster output validated) and the backfill contract (`magpie validate` before flipping the app on)
- [ ] 11.4 Document the deferred list: async projections, multi-tenancy, multi-stream projections, driver adapters, cursor pagination, multi-stage upcast chains
