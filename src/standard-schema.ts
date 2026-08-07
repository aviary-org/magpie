import type { StandardSchemaV1 } from "@standard-schema/spec";

/** The output shape a Standard Schema produces. */
export type SchemaOutput<TSchema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<TSchema>;

export type ValidationIssue = StandardSchemaV1.Issue;

/** The outcome of validating unknown data against a schema. */
export type ValidationResult<TOutput> =
  | { readonly ok: true; readonly value: TOutput }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export async function validateWith<TOutput>(
  schema: StandardSchemaV1<unknown, TOutput>,
  data: unknown,
): Promise<ValidationResult<TOutput>> {
  const result = await schema["~standard"].validate(data);
  if (result.issues) {
    return { ok: false, issues: result.issues };
  }
  return { ok: true, value: result.value };
}

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const standard = (value as { readonly "~standard"?: unknown })["~standard"];
  if (typeof standard !== "object" || standard === null) {
    return false;
  }
  const props = standard as { readonly version?: unknown; readonly validate?: unknown };
  return props.version === 1 && typeof props.validate === "function";
}
