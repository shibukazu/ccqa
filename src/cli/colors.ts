/**
 * ANSI palette for ccqa's own summary blocks (the run summary, the failure
 * analysis block). Every entry is the empty string when stdout is not a TTY or
 * `NO_COLOR` is set, so the same template literals render clean plain text in
 * CI logs without the caller branching on colour support.
 */
const useColor = process.stdout.isTTY && process.env.NO_COLOR == null;

export const C = {
  reset: useColor ? "\x1b[0m" : "",
  bold: useColor ? "\x1b[1m" : "",
  dim: useColor ? "\x1b[2m" : "",
  green: useColor ? "\x1b[32m" : "",
  red: useColor ? "\x1b[31m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  gray: useColor ? "\x1b[90m" : "",
};
