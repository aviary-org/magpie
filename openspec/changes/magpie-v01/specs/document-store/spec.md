## Purpose

Provides document storage on Postgres: storing and querying application objects as JSONB without per-type relational schema, with optimistic concurrency and explicit deletion semantics.

## ADDED Requirements

### Requirement: Store and retrieve a document by stable id

The document store SHALL persist arbitrary application objects as JSONB, identified by a stable id, without requiring a hand-authored relational table per type. A registered document type SHALL be stored in a dedicated table (one table per document type) that the library creates and manages. Retrieving a document by id SHALL return the document if it exists, and SHALL return nothing (not an error) if it does not exist.

#### Scenario: Save then load a document
- **WHEN** a developer saves a document under a registered type with a given id
- **THEN** the document is persisted as JSONB and loading it by that id returns an equal object

#### Scenario: Load a missing id
- **WHEN** a developer loads a document by an id that has never been saved
- **THEN** the operation returns nothing, without raising an error

#### Scenario: Different types do not share storage
- **WHEN** a developer saves two documents of different registered types with the same id
- **THEN** each is stored in its own type's table and loading by id and type returns each one independently

### Requirement: Query documents by the shape of their data

The document store SHALL support querying documents by the shape of their data, not only by id: filter, sort, and paginate over stored documents. Filters SHALL support arbitrarily nested fields within a document's structure. Pagination SHALL be offset-based (`limit`/`offset`). A document's nested fields SHALL be referenceable at registration time through a field-path utility built on the schema's inferred output type.

#### Scenario: Filter by nested field
- **WHEN** a developer queries a document type with a filter on a nested field (e.g. `address.city`)
- **THEN** only documents whose nested field matches the filter condition are returned

#### Scenario: Sort and paginate
- **WHEN** a developer queries a document type with a sort order, a limit, and an offset
- **THEN** results are returned in the requested order, limited to the limit, starting at the offset

#### Scenario: Combine filter conditions
- **WHEN** a developer queries with multiple conditions combined with AND or OR
- **THEN** only documents satisfying the combined condition are returned

### Requirement: Detect and reject conflicting concurrent writes

The document store SHALL detect conflicting concurrent writes to the same document by default and reject the losing write with a concurrency error. The developer SHALL be able to explicitly allow an unconditional write, bypassing the conflict check, as a deliberate opt-in.

#### Scenario: Concurrent update conflict
- **WHEN** two concurrent operations attempt to save different versions of the same document
- **THEN** the second write to commit is rejected with a concurrency error, and the first write's version remains the stored version

#### Scenario: Explicit bypass
- **WHEN** a developer saves a document with the explicit "any version" bypass
- **THEN** the write succeeds unconditionally regardless of the currently stored version, and the stored version advances

### Requirement: Soft and hard deletion as distinct operations

The document store SHALL support soft deletion and hard deletion as distinct operations. Soft deletion SHALL mark a document as deleted while retaining its stored data, and SHALL exclude soft-deleted documents from normal retrieval and queries. Hard deletion SHALL remove the document's row from storage entirely.

#### Scenario: Soft delete hides the document
- **WHEN** a developer soft-deletes a document and then loads it by id
- **THEN** the load returns nothing, and a query over the type excludes the document

#### Scenario: Hard delete removes the row
- **WHEN** a developer hard-deletes a document
- **THEN** the document is removed from storage and subsequent loads return nothing

### Requirement: Shape evolution without immediate migration

The document store SHALL allow a document type's shape to change over time without requiring every existing stored document to be migrated immediately. Reading an old-shaped document SHALL NOT rewrite its stored representation.

#### Scenario: Old and new shapes coexist
- **WHEN** a developer changes a document type's schema and saves a new-shaped document while old-shaped documents remain stored
- **THEN** both old- and new-shaped documents remain readable without rewriting stored data
