## Purpose

Defines how document and event shapes are declared, validated, and evolved: Standard Schema-based definitions, explicit event-name registration, and read-time upcasting instead of rewriting stored data.

## ADDED Requirements

### Requirement: Shapes declared via Standard Schema

Document and event shapes SHALL be described with a schema that conforms to the Standard Schema interface, so teams can use their schema library of choice (Zod, Valibot, ArkType, etc.). The library SHALL NOT require any specific validation library. Storage and indexing metadata (which field is the id, index fields, casts, tenancy, soft-delete participation) SHALL live in a separate, validator-agnostic registration alongside the schema, never merged into the schema itself.

#### Scenario: Any Standard Schema validator works
- **WHEN** a developer declares a document or event shape with any validator that conforms to Standard Schema
- **THEN** the shape is accepted and validated by the store without requiring a specific validation library

#### Scenario: Storage metadata is separate from the schema
- **WHEN** a developer configures a document's id field, indexes, or field casts
- **THEN** that configuration is expressed in a separate registration surface, and the schema itself carries only shape and validation

### Requirement: Validate incoming data before storage

The store SHALL validate incoming data against its declared shape before storing it. Validation SHALL always run at ingestion (save and append). Data already validated at ingestion SHALL NOT be re-validated on replay, on fold, or on direct reads by default.

#### Scenario: Invalid document rejected at save
- **WHEN** a developer saves a document that does not conform to its registered shape
- **THEN** the save is rejected with validation issues and nothing is stored

#### Scenario: Invalid event rejected at append
- **WHEN** a developer appends an event that does not conform to its registered shape
- **THEN** the append is rejected and no events are stored

### Requirement: Explicit event-name-to-shape registration

The mapping between a stored event name and its current shape SHALL be registered explicitly by the developer. There SHALL be no reflection-based or convention-based automatic discovery of event types.

#### Scenario: Unregistered event name is rejected
- **WHEN** a developer appends an event whose stored name has no registered shape
- **THEN** the append is rejected

### Requirement: Read-time upcasting for shape evolution

A document or event type's shape SHALL be able to evolve across versions via read-time transformation (upcasting) rather than rewriting stored data. An upcaster SHALL transform an old-shaped stored event into the current shape. Upcaster output SHALL be validated against the current shape, because upcasting is a hand-written transform that can produce a schema/reality mismatch. Upcasting SHALL run before any fold or read logic sees the event. Simple upcasting (one old shape to one new shape) is in scope; multi-stage chains and "one event splits into two" are out of scope for v0.1.

#### Scenario: Old events read as current shape
- **WHEN** a developer registers an upcaster for an old event shape and reads a stream containing events of that old shape
- **THEN** the read returns events transformed to the current shape, and the stored data is unchanged

#### Scenario: Invalid upcaster output is rejected
- **WHEN** an upcaster produces output that does not conform to the current shape
- **THEN** the read is rejected with validation issues rather than silently returning malformed data

#### Scenario: Stored data is never rewritten
- **WHEN** a developer reads old-shaped events that have an upcaster
- **THEN** the stored representation remains the old shape; the upcasting happens at read time only

### Requirement: Event schema versions are named, not numbered

A stored event's schema version SHALL be expressed in its stored event name (e.g. `order_completed_v2`), not in a separate per-event version column. Upcasters SHALL be keyed by the stored event name they apply to, with no multi-stage chain.

#### Scenario: Versioned event names
- **WHEN** a developer evolves an event shape and appends the new shape under a versioned name
- **THEN** the stored event carries the versioned name, and an upcaster registered for the old name transforms old events to the current shape
