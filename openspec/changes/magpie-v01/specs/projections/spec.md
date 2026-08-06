## Purpose

Defines how a stream's events fold into a shape, reused across lifecycles: computed live on demand, or persisted synchronously (inline) as part of the write. Projected output is stored and queried like a document.

## ADDED Requirements

### Requirement: One fold definition, multiple lifecycles

A single fold definition SHALL be registered once and reused across lifecycles: `live` (computed on demand from a stream's events, nothing persisted) and `inline` (persisted synchronously as part of the triggering write). Async/background projection is out of scope for v0.1.

#### Scenario: Same definition, both lifecycles
- **WHEN** a developer registers a fold definition
- **THEN** the same definition can be invoked live (on demand, unpersisted) and inline (persisted with each write)

#### Scenario: Live lifecycle never persists
- **WHEN** a developer reads the live aggregate of a stream
- **THEN** the result is computed from events on demand and no storage row is written

### Requirement: Inline projection reflects events in the write

An inline projection SHALL update its persisted output synchronously, within the same transaction as the event write that triggers it. A synchronous projection SHALL reflect an event the moment that event's write is acknowledged.

#### Scenario: Projection is current after the write
- **WHEN** a developer appends an event to a stream with an inline projection and the write is acknowledged
- **THEN** the projection's persisted output reflects the new event

#### Scenario: Failed write leaves projection unchanged
- **WHEN** a developer appends an event and the write fails (for example, a concurrency conflict)
- **THEN** neither the event nor the projection's output is changed

### Requirement: Projected output is a queryable document

An inline projection's persisted output SHALL live in the same kind of storage a directly-saved document uses, and SHALL be queryable through the same query surface (filter, sort, paginate) used for documents.

#### Scenario: Query projected output like a document
- **WHEN** a developer queries the projection's output type using document queries
- **THEN** projection rows are returned by the same filter/sort/paginate surface used for hand-saved documents

#### Scenario: Live aggregate is not queryable
- **WHEN** a developer attempts to query the output of a live-only aggregate
- **THEN** the attempt is rejected, because a live aggregate has no stored rows to query

### Requirement: Aggregate identity is the stream id

In v0.1, an aggregate's identity SHALL be the stream id it is folded from. The aggregate referenced by a stream's events SHALL have the same id as the stream.

#### Scenario: Snapshot row id equals stream id
- **WHEN** an inline projection writes its persisted output for a stream
- **THEN** the output row's id is the stream's id

### Requirement: Streams own their event contract; aggregates reference streams

A `stream()` registration SHALL define which events may be appended (a write-time contract), and an `aggregate()` registration SHALL reference a stream and define fold logic over it (a read-time concern). Multiple aggregates SHALL be able to fold the same stream.

#### Scenario: Two aggregates over one stream
- **WHEN** a developer registers two aggregates that both fold the same stream
- **THEN** both are valid and each computes its own output from the same events

#### Scenario: Stream contract independent of aggregates
- **WHEN** a stream allows events that no aggregate folds
- **THEN** those events remain appendable and readable; the stream contract does not depend on aggregate registrations

### Requirement: Upcasted events reach fold logic

Fold logic SHALL only ever operate on the current shape of an event, regardless of how old the underlying stored event is. The upcasting pipeline SHALL run before fold logic sees an event, for live aggregation and inline projection updates alike.

#### Scenario: Fold over an old-shaped event
- **WHEN** a stream contains an old-shaped event for which an upcaster is registered, and the aggregate is folded
- **THEN** the fold function receives the upcast, current-shaped event, never the raw stored shape
