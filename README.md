# Magpie

**Status: design phase.** The v0.1 scope, specifications, and technical design are captured in the OpenSpec change [`openspec/changes/magpie-v01/`](openspec/changes/magpie-v01/). No implementation exists yet.

A single TypeScript library that turns Postgres into a **document store**, an **event store**, and one **consistency boundary** — the design is inspired by Marten, the .NET library that established this pattern. The goal is that a team building an event-sourced or document-heavy backend gets one dependency, one connection, and one mental model instead of assembling a document layer, a hand-rolled event table, and custom projection logic per project.

## What it does (v0.1 scope)

- **Document store** — save, retrieve, and query arbitrary application objects as JSONB (`magpie_doc_<alias>` tables, one per type), with nested-field filtering, sorting, offset pagination, optimistic concurrency, and soft/hard delete.
- **Event store** — append immutable events to named streams with strict per-stream ordering and stream-level optimistic concurrency; read full or partial history; fold a stream's events into current state on demand.
- **One transaction** — a single Postgres transaction is the unit of work spanning documents, event appends, and inline projections, all-or-nothing.
- **Inline projections** — one fold definition, reused live (on demand, unpersisted) and inline (persisted in the same transaction as the write). Projected output is stored and queried like a document.
- **Standard Schema shapes** — document and event shapes declared with any Standard Schema-compatible validator (Zod, Valibot, ArkType, …), validated at ingestion; no reflection-based discovery.
- **Read-time upcasting** — shapes evolve across versions by transforming old stored rows at read time, never rewriting history.

## Non-goals (explicitly out of scope for v0.1)

Async/background projections and the projection daemon, multi-tenancy, multi-stream projections, catch-up/lag introspection, and non-Postgres databases. See the proposal's scope for details.

## Repository layout

```
openspec/            OpenSpec store (proposals, specs, design, tasks)
  changes/magpie-v01  the v0.1 change — proposal, 6 capability specs, design, tasks
  specs/              main specs (populated on archive)
.agents/skills/       agent skills (openspec, opensrc)
```

## Design

The technical design and all resolved decisions (D1–D11) live in [`openspec/changes/magpie-v01/design.md`](openspec/changes/magpie-v01/design.md): per-type tables in a configurable schema, `bigint` version columns, postgres-js as the injected driver, typed field-path query building, validator-agnostic storage metadata (per-field casts/indexes), event schema versions baked into stored names, an explicit callback session as the unit of work, and explicit idempotent DDL via `magpie migrate`.

## Development

The package manager is **pnpm** (`^11.5.3`); the package is ESM (`"type": "module"`).

```bash
pnpm install
```

There is no source code or test suite yet — the implementation is planned as tracked tasks in the OpenSpec change. Work on this repo is driven through the OpenSpec workflow (see [`AGENTS.md`](AGENTS.md)).

## License

MIT
