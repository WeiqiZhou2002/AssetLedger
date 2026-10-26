export type JsonSafe<T> = T extends bigint
  ? string
  : T extends Date
    ? string
    : T extends readonly (infer U)[]
      ? JsonSafe<U>[]
      : T extends object
        ? { [K in keyof T]: JsonSafe<T[K]> }
        : T;
export function jsonSafe<T>(value: T): JsonSafe<T> {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item)),
  ) as JsonSafe<T>;
}
