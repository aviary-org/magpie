import type { ValidationIssue } from "./standard-schema.js";

/** Rejects an optimistic-concurrency guard: the expected version no longer matches. */
export class ConcurrencyError extends Error {
  override readonly name = "ConcurrencyError";
}

/** Thrown by `session.rollback()`; the session layer catches it to abort without an error. */
export class RollbackSignal extends Error {
  override readonly name = "RollbackSignal";
}

/** A payload failed validation against its registered shape. */
export class ValidationError extends Error {
  override readonly name = "ValidationError";
  readonly issues: readonly ValidationIssue[];
  constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.issues = issues;
  }
}
