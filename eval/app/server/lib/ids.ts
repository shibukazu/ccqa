/** Parse a route or query id: a positive integer, or undefined for anything else. */
export function parseId(value: string): number | undefined {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}
