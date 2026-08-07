# AGENTS.md

Guidance for AI agents and contributors working in this repository.

**Keep this file and the OpenSpec change [`openspec/changes/magpie-v01/`](openspec/changes/magpie-v01/) in sync.** When code or behavior changes, update the relevant change artifacts (`design.md`, `specs/`, `tasks.md`); when they change, update this file.

## Project Overview

A single TypeScript library (`@aviary-org/magpie`) that turns Postgres into a **document store**, an **event store**, and one **consistency boundary**. ESM, pnpm (`^11.5.3`), MIT. Implementation in progress; the v0.1 scope is tracked in the OpenSpec change `magpie-v01`.

Authoritative docs, in order:
1. `openspec/changes/magpie-v01/proposal.md` — why and what (scope, non-goals)
2. `openspec/changes/magpie-v01/specs/` — the behavior contract (6 capabilities: `document-store`, `event-store`, `projections`, `consistency`, `schema-contracts`, `operability`)
3. `openspec/changes/magpie-v01/design.md` — how (decisions D1–D11)
4. `openspec/changes/magpie-v01/tasks.md` — the tracked implementation plan

When in doubt, follow the change artifacts.

## Domain Model

Speak the domain's language — these terms are precise:

- **Document** — an application object stored as JSONB, one table per registered type (`magpie_doc_<alias>`), identified by a stable id.
- **Stream** — the history of one entity (one order, one account); owns the *write-time* contract of which events may be appended.
- **Event** — an immutable fact appended to a stream, strictly ordered per-stream, with its schema version baked into its stored name (e.g. `order_completed_v2`).
- **Aggregate / fold** — "how these events fold into this shape," registered once, reused across lifecycles: `live` (on demand, unpersisted) and `inline` (persisted in the write's transaction). Aggregate identity is the stream id in v0.1.
- **Upcaster** — a read-time transform from an old stored event shape to the current shape; keyed by the stored name; runs before any fold or read logic sees an event.
- **Session** — the unit of work: one Postgres transaction wrapping document saves, event appends, and inline projection updates.
- **Expected version** — the optimistic-concurrency token read from a loaded document/stream and passed back on write; `"any"` is the explicit bypass for documents.

## Design Constraints (non-negotiable)

From `design.md` D1–D11 — the decisions that shape every implementation choice:

- **No reflection-based discovery.** TypeScript erases types at runtime. Shapes come from Standard Schema validators (any validator: Zod, Valibot, ArkType, …); storage metadata (id field, casts, indexes) lives in a separate validator-agnostic registration surface, never merged into the schema.
- **Explicit casts.** Because TS has no runtime types, per-field casts are user-expressible (`t.path.x.cast("uuid")`) alongside indexes in the document config callback; defaults cover `number`→`numeric`, `boolean`, `Date`→`timestamptz`, `bigint`, `string`.
- **Single driver:** `postgres` (postgres-js), user-injected as `createStore({ sql })`. No driver abstraction in v0.1.
- **Explicit DDL:** `store.migrate()` / `magpie migrate`, idempotent. No auto-DDL at runtime by default; opt-in `autoCreate: true` for dev only.
- **`bigint` versions** on all documents and streams; projection snapshots source their version from the stream version.
- **Offset pagination** (`limit`/`offset`), not cursors — a deliberate choice.
- **Inline projections write in the same transaction** as the events that trigger them; the write is not acknowledged before the projection is current.
- **Append auto-creates missing streams**; `expectedVersion` expresses intent (`0` = must not exist, `N` = must be at N).
- **Do not re-validate on read/replay** — validation runs at ingestion and on upcaster output only. Backfill integrity is checked via the `magpie validate` operation, not the hot read path.

## OpenSpec Workflow

Work on this repo is driven through the OpenSpec artifact workflow (OPSX). The CLI is `openspec` (schema `spec-driven`); the agent skill at `.agents/skills/openspec/` documents it fully.

- `/opsx:apply` — implement tracked tasks from `tasks.md`, marking `- [ ]` → `- [x]` as you go
- `/opsx:verify` — validate the implementation matches the change's specs
- `/opsx:sync` — move delta specs into `openspec/specs/`
- `/opsx:archive` — close a completed change

CLI preflight and validation:

```bash
openspec status --change magpie-v01       # artifact readiness
openspec validate magpie-v01 --strict     # spec/scenario conformance
```

When implementing: update `tasks.md` checkboxes, and update `design.md`/`specs/` if the implementation reveals a wrong decision — the artifacts are the source of truth, not the code.

## Repository Layout

```
openspec/            OpenSpec store
  changes/magpie-v01  active change (proposal, specs/, design.md, tasks.md)
  specs/              main specs (synced on archive)
  config.yaml         schema + optional project context/rules
src/                 library source
  index.ts            entry point (exports land here as the API grows)
test/                Vitest suite (integration tests need the docker-compose Postgres)
.agents/skills/       agent skills (openspec, opensrc — fetch dependency source)
README.md
AGENTS.md
```

## Conventions

### TypeScript

- `strict` mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; don't relax these.
- `any` is never allowed. Use `unknown` only at real boundaries (parsing JSON, driver callbacks) and narrow it before use.
- Explicit return types on exported functions.
- Prefer `readonly` fields / `ReadonlyArray` / `ReadonlyMap` for committed/immutable data.

### Naming

- `camelCase` for variables/functions, `PascalCase` for types/classes, `SCREAMING_SNAKE_CASE` for module-level constants.
- Booleans read as predicates: `isActive`, `hasPermission`, `canEdit` — never bare adjectives.
- Async functions get a verb: `fetchUser()`, not `user()`. Mutators are imperative (`sortItems`); pure derivations are noun-ish (`sortedItems`).
- One name per concept, everywhere — no alternating `user`/`customer`/`client`; use the domain terms above.
- No abbreviations (`templateName`, not `tmplName`); no vague catch-alls (`data`, `temp`, `value`) beyond a genuinely scoped last resort.
- Singular/plural must match cardinality.

### Comments

- Default to no comments; names and structure should carry the meaning.
- Doc comments (`/** ... */`) state succinct *intent* — what the thing is for, one line where possible, no `@param`/`@returns` boilerplate.
- Inline comments only for **why**: a non-obvious invariant, a constraint from the change artifacts, a workaround for a specific bug.

### Hygiene

- No dead code, no commented-out code — delete it; git history has it.
- No speculative error handling for cases that can't occur given the code above it; validate at real boundaries (user options, Postgres/driver responses, file reads).
- No circular imports; the dependency graph must be a DAG. Optional peer dependencies are lazily imported via dynamic `import()` — never a static top-level import.

## Commands

- `pnpm install` — install dependencies (pnpm `^11.5.3`; `devEngines` will auto-download if absent)
- `pnpm test` — Vitest suite; integration tests need the local Postgres from `docker compose up -d` (see `test/helpers/test-db.ts` for env overrides)
- `openspec status --change magpie-v01` / `openspec validate magpie-v01 --strict` — change state and conformance
