# 0036. The audit always writes its report

- Status: accepted
- Date: 2026-09-21

Replaces the `--brief` output described in
[ADR-0030](0030-the-audit-reads-the-product.md) and
[ADR-0035](0035-test-drift-is-repairable-wherever-it-is-written.md).

## Context and problem statement

`ccqa audit` grew two machine-readable outputs that overlapped almost
entirely. `--report-format json` printed every audited case to stdout;
`--brief <dir>` wrote one file per finding, carrying the same diagnosis plus
the four fields that say how to repair it. A caller wanting both had to ask
for both, and had to know that "brief" was the one with the repair in it —
a word invented here, which readers had to be told the meaning of.

`ccqa run` had already settled the same question the other way: it always
writes `<report-dir>/report.json`, and only uploads when asked. The audit
disagreed with its sibling for no reason anyone could state.

## Considered options

- **Keep both.** No migration, and no answer to the original complaint: two
  payloads that differ by four fields, one of them named after nothing.
- **Fold everything into the stdout JSON and drop the file.** One payload and
  no new path to document. Rejected on two counts. Stdout is fragile: any
  library or hook that prints a line corrupts the document, and this codebase
  had such a line. And `--report-format` is exclusive, so a job could not have
  GitHub annotations *and* the payload from one paid sweep; audits cost model
  time, so making a caller choose means making them pay twice.
- **Always write the file, and print the same payload when asked.** Chosen.

## Decision outcome

**Every completed sweep writes `<report-dir>/audit.json`**, defaulting to the
same `ccqa-report/` directory `ccqa run` uses and moved with the same
`--report-dir` flag — whatever `--report-format` says, and whether or not
anything drifted.

"Completed" is the whole of it, because a reader cannot tell a stale file from
a fresh one. The previous file is removed before the sweep begins, so an
invocation that stops early — a mistyped case id, a refused flag combination,
an unreadable source root — leaves nothing rather than findings that answer a
question nobody asked this time. The file holds the rows of the last
invocation and no other, so naming one case writes a one-row file over a
sweep's.

**One payload, one function.** `buildAuditReport` produces it; the file and
`--report-format json` are the same bytes, and in any non-text format stdout
carries that payload and nothing else — which was the intent and was not true,
since `--dump-inputs` logged its path under every format. `test`, `document`
and `repair` are
added only to a row that has a finding, because they exist to repair one and
are noise on a clean row. `feature` and `spec` stay beside `case`, since
existing consumers read them and this adds keys rather than renaming any.

`--brief` is gone, along with the word. What it carried is a row of the
report, and the module that computes it is named for what it does.

Nothing new reaches the hub's **wire schema**: `--report-to-hub` is unchanged,
and `repair` and the renames behind it stay out of it (ADR-0035). The file
itself is an ordinary artifact — `ccqa hub push --report-dir` tars the report
directory, so it rides along like any other.

### Consequences

- Good: one output, present by default, named after what it is. A caller no
  longer opts in to the thing it needs, and no longer chooses between
  annotations and data.
- Good: the audit and the run now answer "where are my results" the same way,
  with the same flag and the same default directory.
- Bad / cost: a breaking change for anything passing `--brief` or reading a
  per-finding file. The payload keys are unchanged, so the migration is the
  path they are read from; `--report-format json` consumers are unaffected
  beyond gaining keys.
- Bad / cost: every sweep now writes a file. That is the point, but it means
  a read-only working directory fails an audit that used to run. It fails
  loudly, with exit 2 and the path it could not write.
- Neutral: `--report-format` still decides only what the terminal gets.

### Confirmation

`buildAuditReport` is unit-tested for each row shape — clean, errored, a
finding carrying its repair — and the routing tests that moved with it cover
one condition per branch. The end-to-end scenario asserts the file appears
without being asked for, honours `--report-dir`, and that `--report-format
json` prints exactly what the file holds even with `--dump-inputs` on.

## More information

- Payload and writer: `src/drift/audit-report.ts`
- Command wiring: `src/cli/audit.ts`; directory default in
  `src/run/report-constants.ts`
- Related: ADR-0030 and ADR-0035 (which describe the output this replaces),
  ADR-0006 (the hub is a separate destination, not this one)
