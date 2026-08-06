## Purpose

Defines the transaction boundary of the store: a single Postgres transaction as the unit of work spanning documents, event appends, and inline projections, with all-or-nothing semantics and correct behavior under concurrent app instances.

## ADDED Requirements

### Requirement: Single transaction as the unit of work

A single logical operation SHALL be able to write to documents and append events together with an all-or-nothing guarantee, committed as one Postgres transaction. If any part of the operation fails, no part SHALL be persisted.

#### Scenario: Document and event commit together
- **WHEN** a developer saves a document and appends an event inside one session
- **THEN** both are persisted when the session commits, and either both succeed or neither is persisted

#### Scenario: Failure rolls back everything
- **WHEN** a developer saves a document and appends an event inside one session, and the event append fails
- **THEN** the document save is also rolled back; no partial state is persisted

#### Scenario: Explicit rollback
- **WHEN** a developer triggers an explicit rollback inside a session
- **THEN** nothing written in the session is persisted

### Requirement: Projection consistency within the write

An inline projection SHALL be updated in the same transaction as the event write that triggers it, by virtue of being part of that transaction. The projected state SHALL be consistent with the events at the moment the transaction commits, with no window in which the write is acknowledged but the projection lags.

#### Scenario: Acknowledged write implies current projection
- **WHEN** a write that appends events and updates an inline projection commits
- **THEN** the projection's persisted output reflects those events, and the write is not acknowledged before the projection is current

### Requirement: Correct behavior across concurrent app instances

The store SHALL behave correctly when multiple instances of the application run and write concurrently. Concurrent writes to the same document or stream SHALL be arbitrated by optimistic concurrency, and concurrent writes to distinct documents or streams SHALL not interfere.

#### Scenario: Concurrent writers to the same stream
- **WHEN** two app instances concurrently append to the same stream
- **THEN** exactly one append succeeds per version; the other is rejected with a concurrency error, and the store remains consistent

#### Scenario: Concurrent writers to different streams
- **WHEN** two app instances concurrently append to different streams
- **THEN** both appends succeed, each in its own transaction, without interference

#### Scenario: Concurrent document saves
- **WHEN** two app instances concurrently save the same document with the same expected version
- **THEN** exactly one save succeeds; the other is rejected with a concurrency error
