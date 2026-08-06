## Purpose

Defines the operational surface of the store: explicit, idempotent database schema bootstrap and backfill integrity validation. Async projection daemon, multi-tenancy, and catch-up introspection are explicitly out of scope for v0.1.

## ADDED Requirements

### Requirement: Explicit DDL bootstrap

Database schema SHALL be applied explicitly and idempotently, via a migrate operation the operator runs (programmatically or via CLI). The library SHALL NOT create or modify schema automatically at runtime by default; an opt-in development mode MAY auto-create schema for convenience. Re-running the migrate operation SHALL be safe and idempotent.

#### Scenario: Migrate creates schema
- **WHEN** an operator runs the migrate operation against a fresh database
- **THEN** all registered document tables, event tables, sequences, and helper functions are created

#### Scenario: Migrate is idempotent
- **WHEN** an operator runs the migrate operation a second time against an already-migrated database
- **THEN** the operation succeeds without error and does not duplicate or corrupt existing schema

#### Scenario: No implicit schema creation by default
- **WHEN** an application using the store starts against a database whose schema has not been migrated
- **THEN** no schema is created automatically; operations that require missing schema fail with an error directing the operator to run the migrate operation

### Requirement: Backfill integrity validation

The store SHALL provide an operation that validates the integrity of stored data against the currently registered shapes, intended for verifying imported or backfilled data. The operation SHALL read every row of the affected streams or document types, validate each row against its registered shape (applying registered upcasters first), report mismatches with row identifiers and validation issues, and indicate failure when any mismatch is found. The operation SHALL NOT modify stored data. Normal reads and folds SHALL NOT re-validate data (see schema-contracts: validation timing), so this operation is the explicit way to check data that was not written by the store.

#### Scenario: Validate clean data
- **WHEN** an operator runs the validation operation over streams whose events all conform to their registered shapes
- **THEN** the operation reports success with no mismatches

#### Scenario: Validate detects malformed rows
- **WHEN** an operator runs the validation operation over data containing rows that do not conform to their registered shapes
- **THEN** the operation reports each mismatched row with its identifier and validation issues, and exits indicating failure

#### Scenario: Validation is read-only
- **WHEN** an operator runs the validation operation
- **THEN** no stored data is modified; the operation only reads and reports

#### Scenario: Upcasters run before validation
- **WHEN** stored data contains old-shaped events with registered upcasters
- **THEN** the validation operation validates the upcast output against the current shape, not the raw stored shape
