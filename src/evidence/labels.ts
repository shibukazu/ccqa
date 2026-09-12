import { useJapanesePrompts } from "../prompts/language.ts";

/**
 * The table's furniture: its headings and the words around the case's own
 * text. A project may put these in the language its reviewers read — the
 * case, its steps and its expectations are already in that language, and a
 * table half in another is one a reviewer skims instead of checks.
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
  case: "Case",
  test: "Test",
  recordedAt: "Recorded",
  from: "From",
  setup: "Before the first step",
  unattributed: "Recorded under no step of the case",
  operations: "operation(s)",
  unconfirmed: "not confirmed in the product's source",
  notFound: "not found",
  notSearched: "not searched",
  ambiguous: "ambiguous",
  partialMatch: "partial match",
  expects: "What the case expects",
  review: "Review",
} as const;

/**
 * What the table concludes, as opposed to what it calls things. ccqa owns
 * these: a project that could rewrite them could make a step nothing checks
 * read as one that passed, and the table is read by people who did not write
 * that config. Translated here rather than configured, for the same reason.
 */
const EVIDENCE_VERDICTS = {
  en: {
    nothing: "nothing",
    reviewClean: "Every step's outcome is decided by the generated test.",
    reviewAbsent: "The generated test was not reviewed against the case.",
    reviewPartial: "The generated test was not otherwise reviewed against the case.",
    findingNothing: "nothing in the generated test is visibly deciding this step",
    findingUndecided: "the generated test passes without deciding what this step claims",
    cleanupUnchecked:
      "The case states these about its cleanup. This project does not allow the generated undo " +
      "to assert (`allowExpectInCleanup: false`), so nothing checks them:",
  },
  ja: {
    nothing: "判定なし",
    reviewClean: "すべての手順の結果を、生成されたテストが判定しています。",
    reviewAbsent: "生成されたテストはテストケースと突き合わせて点検されていません。",
    reviewPartial: "生成されたテストは、これ以外の点ではテストケースと突き合わせて点検されていません。",
    findingNothing: "この手順を判定しているものが、生成されたテストに見当たりません",
    findingUndecided: "この手順が主張していることを判定しないまま、生成されたテストは通ります",
    cleanupUnchecked:
      "ケースは後処理について次を期待しています。このプロジェクトは生成された後処理に検証を書くことを" +
      "許可していない（`allowExpectInCleanup: false`）ため、いずれも検証されていません:",
  },
} as const;

const LABELS_JA: Partial<Record<EvidenceLabelKey, string>> = {
  step: "手順",
  instruction: "テストケースの記述",
  recorded: "収録した操作",
  decides: "テストが判定していること",
  source: "製品ソース上の根拠",
  screens: "画面",
  case: "ケース",
  test: "テスト",
  recordedAt: "収録日時",
  from: "起点",
  setup: "最初の手順より前",
  unattributed: "どの手順にも紐づかない記録",
  operations: "操作",
  unconfirmed: "根拠を1箇所に特定できず",
  notFound: "見つからない",
  notSearched: "未検索",
  ambiguous: "複数該当",
  partialMatch: "部分一致",
  expects: "このケースが期待すること",
  review: "点検",
};

export type EvidenceLabelKey = keyof typeof EVIDENCE_LABELS;
export type EvidenceVerdicts = Record<keyof (typeof EVIDENCE_VERDICTS)["en"], string>;
export type EvidenceLabels = Record<EvidenceLabelKey, string> & EvidenceVerdicts;

export const EVIDENCE_LABEL_KEYS = Object.keys(EVIDENCE_LABELS) as EvidenceLabelKey[];

/** ccqa's own words for the run's language, with the project's overrides on top. */
export function evidenceLabels(
  overrides?: Partial<Record<EvidenceLabelKey, string>>,
  language?: string,
): EvidenceLabels {
  const ja = useJapanesePrompts(language);
  return {
    ...EVIDENCE_LABELS,
    ...(ja ? LABELS_JA : {}),
    ...EVIDENCE_VERDICTS[ja ? "ja" : "en"],
    ...overrides,
  };
}
