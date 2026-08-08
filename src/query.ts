import type { ISql, JSONValue, PendingQuery, Row, Sql } from "postgres";
import { castExpression, dataExtraction, dataJsonExtraction } from "./ddl.js";
import type { FieldSpec } from "./document.js";
import type { MagpieNames } from "./naming.js";
import type { DocumentRegistration } from "./registry.js";

/** A postgres-js fragment: SQL text plus parameters, embeddable in another template. */
type Fragment = PendingQuery<Row[]>;

/** Sql handle whose parameters admit bigints; postgres-js serializes them as int8. */
type QuerySql = ISql<{ int8: bigint }>;

/** The parameter kinds a leaf comparison binds; bigint needs the int8-admitting handle. */
type QueryParam = string | number | boolean | Date | bigint | null;

/** The leaf operators a field path can express. */
export type LeafOp =
  | "eq"
  | "ne"
  | "lt"
  | "gt"
  | "lte"
  | "gte"
  | "in"
  | "isNull"
  | "notNull"
  | "startsWith"
  | "endsWith"
  | "contains"
  | "between";

/** A single field comparison, produced by a path operator. */
export interface LeafCondition {
  readonly kind: "leaf";
  readonly path: readonly string[];
  readonly op: LeafOp;
  /** The operand; absent for `isNull`/`notNull`. */
  readonly value: unknown;
}

export interface AndCondition {
  readonly kind: "and";
  readonly conditions: readonly Condition[];
}

export interface OrCondition {
  readonly kind: "or";
  readonly conditions: readonly Condition[];
}

/** A filter expression: a leaf comparison or an and/or composition. */
export type Condition = LeafCondition | AndCondition | OrCondition;

/** One sort term produced by `path.asc()` / `path.desc()`. */
export interface SortHandle {
  readonly path: readonly string[];
  readonly direction: "asc" | "desc";
}

/** The mutable, chainable query over one registered document type. */
export interface DocumentQuery<TOutput> {
  /** Adds conditions, combined with AND; repeatable. */
  where(...conditions: readonly Condition[]): DocumentQuery<TOutput>;
  /** Adds sort terms in priority order; repeatable. */
  orderBy(...sorts: readonly SortHandle[]): DocumentQuery<TOutput>;
  limit(count: number): DocumentQuery<TOutput>;
  offset(count: number): DocumentQuery<TOutput>;
  /** Executes the query and returns the stored documents. */
  toArray(): Promise<readonly TOutput[]>;
}

/** Combines conditions so every one must hold. */
export function and(...conditions: readonly Condition[]): Condition {
  return { kind: "and", conditions };
}

/** Combines conditions so at least one must hold. */
export function or(...conditions: readonly Condition[]): Condition {
  return { kind: "or", conditions };
}

/** Compares only orderable field kinds. */
type Orderable<TValue> = TValue extends number | string | Date | bigint ? TValue : never;
/** String-only operators stay string-typed even on non-string fields. */
type TextValue<TValue> = TValue extends string ? string : never;
/** `contains` accepts the natural containment value of the field. */
type ContainsValue<TValue> = TValue extends readonly unknown[]
  ? TValue
  : TValue extends Date
    ? TValue
    : TValue extends object
      ? Partial<TValue>
      : TValue;

/** The operators and sorters available on every field path node. */
export interface QueryNodeMethods<TPath extends readonly string[], TValue> {
  readonly path: TPath;
  eq(value: TValue): Condition;
  ne(value: TValue): Condition;
  lt(value: Orderable<TValue>): Condition;
  gt(value: Orderable<TValue>): Condition;
  lte(value: Orderable<TValue>): Condition;
  gte(value: Orderable<TValue>): Condition;
  in(values: readonly TValue[]): Condition;
  isNull(): Condition;
  notNull(): Condition;
  startsWith(prefix: TextValue<TValue>): Condition;
  endsWith(suffix: TextValue<TValue>): Condition;
  contains(value: ContainsValue<TValue>): Condition;
  between(lo: Orderable<TValue>, hi: Orderable<TValue>): Condition;
  asc(): SortHandle;
  desc(): SortHandle;
}

/**
 * A typed field path over a shape: object fields descend, every node also
 * carries the leaf operators and sorters.
 */
export type QueryNode<TValue, TPath extends readonly string[]> = QueryNodeOf<
  NonNullable<TValue>,
  TPath
>;

type QueryNodeOf<TValue, TPath extends readonly string[]> = [TValue] extends [Date]
  ? QueryNodeMethods<TPath, TValue>
  : [TValue] extends [readonly unknown[]]
    ? QueryNodeMethods<TPath, TValue>
    : [TValue] extends [object]
      ? {
          readonly [K in keyof TValue & string]: QueryNode<TValue[K], [...TPath, K]>;
        } & QueryNodeMethods<TPath, TValue>
      : QueryNodeMethods<TPath, TValue>;

/** Builds a query over a registered document type; the store wires the sql handle in. */
export function makeDocumentQuery(
  sql: Sql,
  names: MagpieNames,
  registration: DocumentRegistration,
  ensureMigrated: () => Promise<void>,
): DocumentQuery<unknown> {
  const querySql = sql as unknown as QuerySql;
  let conditions: readonly Condition[] = [];
  let sorts: readonly SortHandle[] = [];
  let limit: number | undefined;
  let offset: number | undefined;
  return {
    where(...added) {
      conditions = [...conditions, ...added];
      return this;
    },
    orderBy(...added) {
      sorts = [...sorts, ...added];
      return this;
    },
    limit(count) {
      assertNonNegative(count, "limit");
      limit = count;
      return this;
    },
    offset(count) {
      assertNonNegative(count, "offset");
      offset = count;
      return this;
    },
    async toArray() {
      await ensureMigrated();
      const table = querySql(names.documentTable(registration.alias));
      const whereFragments = [
        querySql`deleted = false`,
        ...conditions.map((condition) =>
          translateCondition(querySql, names, registration.fields, condition),
        ),
      ];
      const parts: Fragment[] = [
        querySql`select data from ${table} where ${joinFragments(querySql, whereFragments, " and ")}`,
      ];
      if (sorts.length > 0) {
        const orderFragments = sorts.map((sort) =>
          sortFragment(querySql, names, registration.fields, sort),
        );
        parts.push(querySql`order by ${joinFragments(querySql, orderFragments, ", ")}`);
      }
      if (limit !== undefined) {
        parts.push(querySql`limit ${limit}`);
      }
      if (offset !== undefined) {
        parts.push(querySql`offset ${offset}`);
      }
      const rows =
        (await querySql`${joinFragments(querySql, parts, "\n")}`) as unknown as readonly {
          readonly data: unknown;
        }[];
      return rows.map((row) => row.data);
    },
  };
}

/** A typed field path root; the store exposes it as `store.path<T>()`. */
export function makeQueryNode(path: readonly string[] = []): QueryNode<unknown, readonly string[]> {
  const node = {
    path,
    eq: (value: unknown) => leafCondition(path, "eq", value),
    ne: (value: unknown) => leafCondition(path, "ne", value),
    lt: (value: unknown) => leafCondition(path, "lt", value),
    gt: (value: unknown) => leafCondition(path, "gt", value),
    lte: (value: unknown) => leafCondition(path, "lte", value),
    gte: (value: unknown) => leafCondition(path, "gte", value),
    in: (values: readonly unknown[]) => {
      if (values.length === 0) {
        throw new Error("in: at least one value is required");
      }
      return leafCondition(path, "in", values);
    },
    isNull: () => leafCondition(path, "isNull"),
    notNull: () => leafCondition(path, "notNull"),
    startsWith: (prefix: string) => leafCondition(path, "startsWith", prefix),
    endsWith: (suffix: string) => leafCondition(path, "endsWith", suffix),
    contains: (value: unknown) => leafCondition(path, "contains", value),
    between: (lo: unknown, hi: unknown) => leafCondition(path, "between", [lo, hi]),
    asc: () => ({ path, direction: "asc" }) as SortHandle,
    desc: () => ({ path, direction: "desc" }) as SortHandle,
  };
  return new Proxy(node, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver);
      }
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      return makeQueryNode([...path, prop]);
    },
  }) as unknown as QueryNode<unknown, readonly string[]>;
}

function leafCondition(path: readonly string[], op: LeafOp, value: unknown = undefined): Condition {
  return { kind: "leaf", path, op, value };
}

function translateCondition(
  sql: QuerySql,
  names: MagpieNames,
  fields: readonly FieldSpec[],
  condition: Condition,
): Fragment {
  switch (condition.kind) {
    case "leaf":
      return translateLeaf(sql, names, fields, condition);
    case "and":
      return condition.conditions.length === 0
        ? sql`true`
        : sql`(${joinFragments(
            sql,
            condition.conditions.map((part) => translateCondition(sql, names, fields, part)),
            " and ",
          )})`;
    case "or":
      return condition.conditions.length === 0
        ? sql`false`
        : sql`(${joinFragments(
            sql,
            condition.conditions.map((part) => translateCondition(sql, names, fields, part)),
            " or ",
          )})`;
  }
}

function translateLeaf(
  sql: QuerySql,
  names: MagpieNames,
  fields: readonly FieldSpec[],
  leaf: LeafCondition,
): Fragment {
  const extraction = dataExtraction(leaf.path);
  switch (leaf.op) {
    case "isNull":
      return sql`${sql.unsafe(extraction)} is null`;
    case "notNull":
      return sql`${sql.unsafe(extraction)} is not null`;
    case "contains":
      return sql`data @> ${sql.json(nestObject(leaf.path, leaf.value) as JSONValue)}`;
    case "eq":
    case "ne":
      if (leaf.value !== null && typeof leaf.value === "object") {
        const operator = leaf.op === "eq" ? "=" : "<>";
        return sql`${sql.unsafe(dataJsonExtraction(leaf.path))} ${sql.unsafe(
          operator,
        )} ${sql.json(leaf.value as JSONValue)}`;
      }
      return compare(sql, names, fields, leaf, extraction, leaf.op === "eq" ? "=" : "<>");
    case "lt":
      return compare(sql, names, fields, leaf, extraction, "<");
    case "gt":
      return compare(sql, names, fields, leaf, extraction, ">");
    case "lte":
      return compare(sql, names, fields, leaf, extraction, "<=");
    case "gte":
      return compare(sql, names, fields, leaf, extraction, ">=");
    case "in": {
      const values = leaf.value as readonly unknown[];
      const cast = resolveCast(fields, leaf.path, values[0]);
      const list = joinFragments(
        sql,
        values.map((value) => castedParam(sql, cast, value)),
        ", ",
      );
      return sql`${castedLeft(sql, names, extraction, cast)} in (${list})`;
    }
    case "between": {
      const [lo, hi] = leaf.value as readonly [unknown, unknown];
      const cast = resolveCast(fields, leaf.path, lo);
      return sql`${castedLeft(sql, names, extraction, cast)} between ${castedParam(
        sql,
        cast,
        lo,
      )} and ${castedParam(sql, cast, hi)}`;
    }
    case "startsWith":
      return sql`${sql.unsafe(extraction)} like ${`${escapeLike(leaf.value as string)}%`}`;
    case "endsWith":
      return sql`${sql.unsafe(extraction)} like ${`%${escapeLike(leaf.value as string)}`}`;
  }
}

function compare(
  sql: QuerySql,
  names: MagpieNames,
  fields: readonly FieldSpec[],
  leaf: LeafCondition,
  extraction: string,
  symbol: string,
): Fragment {
  const cast = resolveCast(fields, leaf.path, leaf.value);
  return sql`${castedLeft(sql, names, extraction, cast)} ${sql.unsafe(
    symbol,
  )} ${castedParam(sql, cast, leaf.value)}`;
}

function sortFragment(
  sql: QuerySql,
  names: MagpieNames,
  fields: readonly FieldSpec[],
  sort: SortHandle,
): Fragment {
  const cast = explicitCastOf(fields, sort.path);
  return sql`${sql.unsafe(castExpression(dataExtraction(sort.path), cast, names))} ${sql.unsafe(
    sort.direction,
  )}`;
}

/** The registered cast wins; otherwise the operand's runtime type picks the default. */
function resolveCast(
  fields: readonly FieldSpec[],
  path: readonly string[],
  value: unknown,
): string | undefined {
  return explicitCastOf(fields, path) ?? defaultCastOf(value);
}

function explicitCastOf(fields: readonly FieldSpec[], path: readonly string[]): string | undefined {
  const key = path.join(".");
  return fields.find((field) => field.path.join(".") === key)?.cast;
}

function defaultCastOf(value: unknown): string | undefined {
  if (typeof value === "number") {
    return "numeric";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (value instanceof Date) {
    return "timestamptz";
  }
  if (typeof value === "bigint") {
    return "bigint";
  }
  return undefined;
}

/** The comparison left side: wrapper call or plain cast over the text extraction. */
function castedLeft(
  sql: QuerySql,
  names: MagpieNames,
  extraction: string,
  cast: string | undefined,
): Fragment {
  return sql.unsafe(castExpression(extraction, cast, names));
}

/** The bound operand, cast to the comparison type so operator resolution succeeds. */
function castedParam(sql: QuerySql, cast: string | undefined, value: unknown): Fragment {
  const param = value as QueryParam;
  return cast === undefined ? sql`${param}` : sql`${param}::${sql.unsafe(cast)}`;
}

/** Nests a value under its path segments for a whole-document containment check. */
function nestObject(path: readonly string[], value: unknown): unknown {
  let current = value;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    current = { [path[i] as string]: current };
  }
  return current;
}

/** Escapes LIKE wildcards so user input is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function joinFragments(sql: QuerySql, fragments: readonly Fragment[], separator: string): Fragment {
  let acc = fragments[0];
  if (acc === undefined) {
    return sql.unsafe("");
  }
  for (let i = 1; i < fragments.length; i += 1) {
    const fragment = fragments[i];
    if (fragment !== undefined) {
      acc = sql`${acc}${sql.unsafe(separator)}${fragment}`;
    }
  }
  return acc;
}

function assertNonNegative(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${what} must be a non-negative integer, got ${value}`);
  }
}
