export type JsonObject = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function getPath(tree: unknown, segments: ReadonlyArray<string>): unknown {
  let current = tree;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * `tree` with `value` at `segments`, keeping every other key where it was so an edited file
 * diffs only where it changed. `undefined` removes the key, and a parent it leaves empty.
 */
export function setPath(tree: unknown, segments: ReadonlyArray<string>, value: unknown): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  const record = isRecord(tree) ? tree : {};
  const child = rest.length === 0 ? value : setPath(record[head], rest, value);
  const removed =
    child === undefined || (rest.length > 0 && isRecord(child) && Object.keys(child).length === 0);
  if (removed) {
    if (!(head in record)) return record;
    const { [head]: _removed, ...remaining } = record;
    return remaining;
  }
  return head in record
    ? Object.fromEntries(
        Object.entries(record).map(([key, old]) => [key, key === head ? child : old]),
      )
    : { ...record, [head]: child };
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => key in right && jsonEqual(left[key], right[key]))
  );
}
