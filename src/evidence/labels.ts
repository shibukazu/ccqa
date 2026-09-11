/**
 * Every fixed word the evidence table prints, so a project can put it in the
 * language its reviewers read. The case's own text is already the project's;
 * these are the words around it, and a table half in another language is one
 * a reviewer skims instead of checks.
 *
 * A closed set: an override the table would never print is a typo, and a
 * config that silently ignores it leaves the reader wondering why the table
 * did not change.
 */
export const EVIDENCE_LABELS = {
  step: "Step",
  instruction: "What the case says",
  recorded: "What was recorded",
  decides: "What the test decides",
  source: "Where the source says so",
  screens: "Screens",
  /** The cell for a step the generated test performs and never checks. */
  nothing: "nothing",
  case: "Case",
  test: "Test",
  recordedAt: "Recorded",
  from: "From",
  setup: "Before the first step",
  operations: "operation(s)",
  unconfirmed: "not confirmed in the product's source",
  notFound: "not found",
  notSearched: "not searched",
  ambiguous: "ambiguous",
  partialMatch: "partial match",
  expects: "What the case expects",
  review: "Review",
  reviewClean: "Every step's outcome is decided by the generated test.",
  reviewAbsent: "The generated test was not reviewed against the case.",
  reviewPartial: "The generated test was not otherwise reviewed against the case.",
  findingNothing: "nothing in the generated test is visibly deciding this step",
  findingUndecided: "the generated test passes without deciding what this step claims",
} as const;

export type EvidenceLabelKey = keyof typeof EVIDENCE_LABELS;
export type EvidenceLabels = Record<EvidenceLabelKey, string>;

export const EVIDENCE_LABEL_KEYS = Object.keys(EVIDENCE_LABELS) as EvidenceLabelKey[];

/** The defaults with the project's overrides applied. */
export function evidenceLabels(overrides?: Partial<EvidenceLabels>): EvidenceLabels {
  return { ...EVIDENCE_LABELS, ...overrides };
}
