/**
 * The half-open `[since, until)` window the run and spend listings both take,
 * as a predicate over a record's ISO-8601 timestamp. Compared as instants, not
 * as strings: the ends come off the wire in whatever offset the caller wrote
 * them in, while the stored field is always UTC.
 */
export function windowFilter(q: { since?: string; until?: string }): (at: string) => boolean {
  const from = q.since === undefined ? null : Date.parse(q.since);
  const to = q.until === undefined ? null : Date.parse(q.until);
  return (at) => {
    const instant = Date.parse(at);
    return (from === null || instant >= from) && (to === null || instant < to);
  };
}
