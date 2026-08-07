import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { SchemaOutput } from "./standard-schema.js";

/** The resolved storage metadata for one document field. */
export interface FieldSpec {
  readonly path: readonly string[];
  /** The explicit cast target (e.g. `"uuid"`), set by `.cast(...)`. */
  readonly cast: string | undefined;
  readonly isPrimaryKey: boolean;
  readonly isIndexed: boolean;
  readonly hasContainsIndex: boolean;
}

/** Chainable metadata builder produced by `t.path...` in the document config callback. */
export interface FieldBuilder<TPath extends readonly string[] = readonly string[]> {
  readonly path: TPath;
  readonly pgType: string | undefined;
  readonly isPrimaryKey: boolean;
  readonly isIndexed: boolean;
  readonly hasContainsIndex: boolean;
  cast(pgType: string): FieldBuilder<TPath>;
  primaryKey(): FieldBuilder<TPath>;
  index(): FieldBuilder<TPath>;
  containsIndex(): FieldBuilder<TPath>;
  toSpec(): FieldSpec;
}

/** The `t` handle passed to the document config callback. */
export interface PathRoot<TOutput> {
  readonly path: PathNode<TOutput, []>;
}

/** Storage metadata for one document type, returned by the config callback. */
export interface DocumentConfig {
  readonly name?: string;
  readonly fields?: readonly FieldBuilder[];
}

export type DocumentConfigFn<TSchema extends StandardSchemaV1> = (
  t: PathRoot<SchemaOutput<TSchema>>,
) => DocumentConfig;

/** Resolved registration inputs for one document type. */
export interface ResolvedDocumentConfig {
  readonly alias: string;
  readonly idField: string;
  readonly fields: readonly FieldSpec[];
}

const DEFAULT_ID_FIELD = "id";
const ALIAS_PATTERN = /^[a-z_][a-z0-9_]*$/;

export function resolveDocumentConfig<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  config?: DocumentConfigFn<TSchema>,
): ResolvedDocumentConfig {
  const built = config?.(makePathRoot<SchemaOutput<TSchema>>());
  const alias = built?.name ?? schemaNameOf(schema);
  if (alias === undefined || !ALIAS_PATTERN.test(alias)) {
    throw new Error(
      `unable to derive a document alias${alias === undefined ? "" : ` from "${alias}"`}; provide a name in the config or on the schema`,
    );
  }
  const fields = (built?.fields ?? []).map((field) => field.toSpec());
  const primaryKeyFields = fields.filter((field) => field.isPrimaryKey);
  if (primaryKeyFields.length > 1) {
    throw new Error(`document "${alias}": at most one field can be the primary key`);
  }
  return {
    alias,
    idField: primaryKeyFields[0]?.path.join(".") ?? DEFAULT_ID_FIELD,
    fields,
  };
}

function schemaNameOf(schema: StandardSchemaV1): string | undefined {
  const name = (schema as { readonly name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

const EMPTY_FIELD_STATE: FieldState = {
  pgType: undefined,
  isPrimaryKey: false,
  isIndexed: false,
  hasContainsIndex: false,
};

interface FieldState {
  readonly pgType: string | undefined;
  readonly isPrimaryKey: boolean;
  readonly isIndexed: boolean;
  readonly hasContainsIndex: boolean;
}

export function makeFieldBuilder(path: readonly string[]): FieldBuilder {
  return makeBuilder(path, EMPTY_FIELD_STATE);
}

function makeBuilder(path: readonly string[], state: FieldState): FieldBuilder {
  return {
    path,
    pgType: state.pgType,
    isPrimaryKey: state.isPrimaryKey,
    isIndexed: state.isIndexed,
    hasContainsIndex: state.hasContainsIndex,
    cast: (pgType) => makeBuilder(path, { ...state, pgType }),
    primaryKey: () => makeBuilder(path, { ...state, isPrimaryKey: true }),
    index: () => makeBuilder(path, { ...state, isIndexed: true }),
    containsIndex: () => makeBuilder(path, { ...state, hasContainsIndex: true }),
    toSpec: () => ({
      path,
      cast: state.pgType,
      isPrimaryKey: state.isPrimaryKey,
      isIndexed: state.isIndexed,
      hasContainsIndex: state.hasContainsIndex,
    }),
  };
}

export function makePathRoot<TOutput>(): PathRoot<TOutput> {
  // The node type is generic over the schema's output; at runtime any key extends the path.
  return { path: makeNode([]) } as unknown as PathRoot<TOutput>;
}

function makeNode(path: readonly string[]): FieldBuilder {
  const builder = makeBuilder(path, EMPTY_FIELD_STATE);
  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver);
      }
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      return makeNode([...path, prop]);
    },
  });
}

type PathNode<TValue, TPath extends readonly string[]> = PathNodeOf<NonNullable<TValue>, TPath>;

type PathNodeOf<TValue, TPath extends readonly string[]> = TValue extends Date
  ? FieldBuilder<TPath>
  : TValue extends readonly unknown[]
    ? FieldBuilder<TPath>
    : TValue extends object
      ? {
          readonly [K in keyof TValue & string]: PathNode<TValue[K], [...TPath, K]>;
        } & FieldBuilder<TPath>
      : FieldBuilder<TPath>;
