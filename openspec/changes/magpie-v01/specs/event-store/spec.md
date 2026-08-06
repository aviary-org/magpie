## Purpose

Provides event storage on Postgres: appending immutable events to named streams with strict ordering and optimistic concurrency, reading stream history, and computing current state by folding a stream's events on demand.

## ADDED Requirements

### Requirement: Append events to a named stream

The event store SHALL append one or more events to a named stream, where a stream represents the history of one entity. Appending to a stream that does not yet exist SHALL create the stream. The set of events that may be legally appended to a stream SHALL be governed by the stream's registration, when one exists; appending an event type not allowed by the stream's registration SHALL be rejected. Events SHALL NOT require a consuming aggregate to be valid: an event's validity is determined entirely by its schema and its stream, not by whether a projection folds it.

#### Scenario: Append a first event creates the stream
- **WHEN** a developer appends an event to a stream that does not exist yet
- **THEN** the stream is created and the event is stored as its first event at version 1

#### Scenario: Append multiple events in one operation
- **WHEN** a developer appends several events to a stream in a single operation
- **THEN** all events are stored with consecutive versions in the given order

#### Scenario: Reject an event type outside the stream's contract
- **WHEN** a developer appends an event whose type is not registered as legal for that stream
- **THEN** the append is rejected and no events are stored

#### Scenario: Audit-trail event with no aggregate
- **WHEN** a developer appends an event type that no aggregate or projection consumes
- **THEN** the append succeeds and the event remains readable from the stream history

### Requirement: Strict per-stream ordering

Events within a stream SHALL be strictly ordered and SHALL never be lost or reordered. Every stored event SHALL carry a per-stream version that increases by exactly one per event, with no gaps within a stream.

#### Scenario: Versions increment by one
- **WHEN** a developer reads a stream's full history after appending events
- **THEN** events are returned in append order with versions 1, 2, 3, ... with no gaps

### Requirement: Stream-level optimistic concurrency

The event store SHALL prevent two concurrent writers from appending conflicting events to the same stream at the same version. A developer SHALL be able to express the expected stream version on append; when the stream's actual version differs, the append SHALL be rejected and no events SHALL be written.

#### Scenario: Concurrent appends to the same stream
- **WHEN** two concurrent operations append to the same stream at the same expected version
- **THEN** one append succeeds and the other is rejected with a concurrency error

#### Scenario: Expected version mismatch
- **WHEN** a developer appends with an expected version that does not match the stream's current version
- **THEN** the append is rejected and the stream is unchanged

### Requirement: Read full or partial stream history

The event store SHALL support reading the full event history of a stream or a slice of it, in order, without modifying stored data.

#### Scenario: Read the full history
- **WHEN** a developer reads a stream's history
- **THEN** all of the stream's events are returned in order

#### Scenario: Read a slice
- **WHEN** a developer reads a slice of a stream's history from a starting version
- **THEN** only the events at and after that version are returned, in order

### Requirement: On-demand aggregation

The event store SHALL support computing the current state of a stream by folding its events into an aggregate, on demand, without persisting the result. Folding a stream with no events SHALL produce the same "absent" outcome as reading a document that does not exist — nothing, not an error.

#### Scenario: Fold a stream's events
- **WHEN** a developer requests the current aggregate state of a stream with events
- **THEN** the aggregate is computed by folding the stream's events in order and returned

#### Scenario: Fold an empty stream
- **WHEN** a developer requests the aggregate of a stream that has never had events
- **THEN** the operation returns nothing rather than raising an error

#### Scenario: Aggregate is not persisted
- **WHEN** a developer folds a stream on demand
- **THEN** no aggregate row is written to storage, and a later fold recomputes from the events
