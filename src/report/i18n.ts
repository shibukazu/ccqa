/**
 * Static UI strings for the HTML run report. The model-driven text (headline,
 * recommendation, reasoning) is already localised via the prompt's
 * outputLanguage; this module covers the chrome around it.
 *
 * Locale resolution is intentionally simple: the BCP-47 tag passed to
 * `ccqa run --language` is matched against the language sub-tag (e.g. "ja",
 * "en") and falls back to English for anything we don't ship strings for.
 * Adding a new locale is a single object literal under STRINGS.
 */

export type ReportLocale = "en" | "ja";
const SUPPORTED_LOCALES: readonly ReportLocale[] = ["en", "ja"] as const;

export interface ReportStrings {
  title: string;
  filterAll: string;
  filterPassed: string;
  filterFailed: string;
  filterPlaceholder: string;
  emptyNote: string;
  predictionAccuracy: string;
  predictionHint: string;
  exportLabels: string;
  importLabels: string;
  kpiLabeled: string;
  kpiAccuracy: string;
  kpiRemaining: string;
  confusionMatrix: string;
  confusionMatrixSub: string;
  perClassMetrics: string;
  perClassMetricsSub: string;
  recommendation: string;
  moreContext: string;
  trueCause: string;
  noteOptional: string;
  analysisSkipped: string;
  needsGrading: string;
  subCause: string;
  subDiagnosisHelp: Record<string, string>;
  /** Human display name for each FAILURE_LABEL / PREDICTED_LABEL enum value. */
  failureLabelDisplay: Record<string, string>;
  /** One-line "what does this category mean" help. */
  failureLabelHelp: Record<string, string>;
  stepEvidence: (n: number) => string;
  metaUrl: string;
  metaPage: string;
  statusPassed: string;
  statusFailed: string;
  collFailureLog: string;
  collFailureLogHelp: string;
  collSourceDiff: string;
  collSourceDiffHelp: string;
  collSpecYaml: string;
  collSpecYamlHelp: string;
  collDriftAudit: (n: number) => string;
  collDriftAuditHelp: string;
}

const EN: ReportStrings = {
  title: "ccqa run report",
  filterAll: "All",
  filterPassed: "passed",
  filterFailed: "failed",
  filterPlaceholder: "Filter by name…",
  emptyNote: "No specs match the current filter.",
  predictionAccuracy: "Prediction accuracy",
  predictionHint:
    "Grade each failed case below with its true cause. Labels are saved in this browser (localStorage) — export them to keep or merge across runs.",
  exportLabels: "Export labels (JSON)",
  importLabels: "Import labels",
  kpiLabeled: "Labeled",
  kpiAccuracy: "Accuracy",
  kpiRemaining: "Remaining",
  confusionMatrix: "Confusion matrix",
  confusionMatrixSub: "predicted × actual",
  perClassMetrics: "Per-class metrics",
  perClassMetricsSub: "precision / recall / F1",
  recommendation: "Recommendation",
  moreContext: "More context",
  trueCause: "True cause",
  noteOptional: "note (optional)",
  analysisSkipped: "analysis skipped",
  needsGrading: "Needs grading",
  subCause: "Sub-cause",
  subDiagnosisHelp: {
    SELECTOR_DRIFT: "A selector (aria-label, placeholder, role+name, …) was renamed or removed in the source. The test still references the old one.",
    TIMING_ISSUE: "The element/state the assertion waits for does eventually appear, but the test's wait was too short. Bumping the timeout or adding a wait usually fixes it.",
    OVER_ASSERTION: "The assertion is true beyond what the spec actually intends — typically a broad `text=…` match that catches surrounding chrome / unrelated UI. Tighten the selector or drop the assertion.",
    DATA_MISSING: "Test data or state the spec depends on is not present in the environment (seeded fixtures, login credentials, feature flags, …).",
    NONE: "",
  },
  failureLabelDisplay: {
    TEST_DRIFT: "Test drift",
    SPEC_CHANGE: "Spec change",
    PRODUCT_BUG: "Product bug",
    UNKNOWN: "Unknown",
  },
  failureLabelHelp: {
    TEST_DRIFT: "The product still behaves the way the spec describes — only the test code drifted. Typical: a renamed selector, a too-tight assertion, a timing change. Fix the test.",
    SPEC_CHANGE: "The thing being verified was intentionally changed (UI redesign, copy rewrite, flow change). The diff cites the change. Re-draft the spec to match the new intent.",
    PRODUCT_BUG: "The change in this PR broke behavior the spec still expects, and the spec is not what is wrong. Treat as a product regression and fix the code.",
    UNKNOWN: "The evidence is too weak to choose between the three categories. Triage the failure by hand — usually the failure log or the screenshot will reveal which side broke.",
  },
  stepEvidence: (n) => `Step evidence (${n})`,
  metaUrl: "URL",
  metaPage: "Page",
  statusPassed: "PASSED",
  statusFailed: "FAILED",
  collFailureLog: "Failure log",
  collFailureLogHelp:
    "The raw stdout/stderr from the failing test run. Open this to see the exact assertion that threw, the timing, and any agent-browser noise that preceded it. Useful when the analysis above is uncertain or you want to grep for a specific error string.",
  collSourceDiff: "Source diff for this spec",
  collSourceDiffHelp:
    "The slice of the PR's diff that touches files this spec depends on (its relatedPaths globs). Open this to check whether the failure was caused by a code change in this PR — and which lines exactly. When the analysis labels the failure SPEC_CHANGE or PRODUCT_BUG, the citation should land in here.",
  collSpecYaml: "Test definition (spec.yaml)",
  collSpecYamlHelp:
    "The original test definition: title, steps, and the expected outcome each step verifies. Open this to confirm what the spec was supposed to do — useful when the test code drifted from the intent, or when re-drafting the spec after a UI change.",
  collDriftAudit: (n) => `Spec vs code audit (${n})`,
  collDriftAuditHelp:
    "A read-only audit that compares the spec's expected assertions against the current source. ERROR rows usually mean the test still asserts something that no longer exists in the code (TEST_DRIFT or SPEC_CHANGE territory). Useful as a hint when triaging — not a verdict.",
};

const JA: ReportStrings = {
  title: "ccqa 実行レポート",
  filterAll: "すべて",
  filterPassed: "成功",
  filterFailed: "失敗",
  filterPlaceholder: "名前でフィルタ…",
  emptyNote: "条件に一致する spec はありません。",
  predictionAccuracy: "予測精度",
  predictionHint:
    "失敗ケースに「実際の原因」をつけて採点してください。ラベルはブラウザ (localStorage) に保存されます。実行をまたぐ場合はエクスポートしてください。",
  exportLabels: "ラベルをエクスポート (JSON)",
  importLabels: "ラベルをインポート",
  kpiLabeled: "採点済み",
  kpiAccuracy: "正解率",
  kpiRemaining: "未採点",
  confusionMatrix: "混同行列",
  confusionMatrixSub: "predicted × actual",
  perClassMetrics: "クラス別メトリクス",
  perClassMetricsSub: "precision / recall / F1",
  recommendation: "推奨アクション",
  moreContext: "詳細な根拠",
  trueCause: "実際の原因",
  noteOptional: "メモ（任意）",
  analysisSkipped: "解析スキップ",
  needsGrading: "未採点",
  subCause: "サブ原因",
  subDiagnosisHelp: {
    SELECTOR_DRIFT: "セレクタ (aria-label / placeholder / role+name 等) がコード側でリネーム・削除され、テストが古い値を参照している状態。",
    TIMING_ISSUE: "assert が待っている要素や状態は最終的に出現するが、テストの待ち時間が短すぎる。タイムアウトを伸ばすか wait を足すと直る。",
    OVER_ASSERTION: "assert が spec の意図より広い範囲を検証してしまっている。たとえば `text=...` の部分一致が周辺UIにヒットしてしまうケース。セレクタを絞るか assert を削除する。",
    DATA_MISSING: "spec が前提とするテストデータや環境状態が揃っていない (シード・ログイン認証・フィーチャーフラグ等)。",
    NONE: "",
  },
  failureLabelDisplay: {
    TEST_DRIFT: "テスト側のずれ",
    SPEC_CHANGE: "spec の変更",
    PRODUCT_BUG: "プロダクトのバグ",
    UNKNOWN: "判定不能",
  },
  failureLabelHelp: {
    TEST_DRIFT: "プロダクトは spec の意図通りに動いているが、テストコードだけが現状から乖離している状態。セレクタのリネーム・過剰アサーション・タイムアウト不足が典型。テスト側を直す。",
    SPEC_CHANGE: "検証対象そのものが意図的に変わった (UI 改修、文言変更、フロー変更)。diff にその変更が含まれているはず。spec を新しい意図に書き直す。",
    PRODUCT_BUG: "今回の PR の変更が spec の期待を壊しており、しかも spec 側が間違っているわけではない。プロダクト側のリグレッションとしてコードを直す。",
    UNKNOWN: "3カテゴリーに分けるための根拠が弱い。失敗ログやスクショから人手で判断する必要がある (大抵どちら側が壊れたかは画面を見ればわかる)。",
  },
  stepEvidence: (n) => `ステップ証跡 (${n})`,
  metaUrl: "URL",
  metaPage: "ページ",
  statusPassed: "成功",
  statusFailed: "失敗",
  collFailureLog: "失敗ログ",
  collFailureLogHelp:
    "失敗したテスト実行の stdout/stderr 生ログです。落ちた assertion・タイミング・直前の agent-browser 出力などを確認したいときに開いてください。上の解析が曖昧なときや、特定のエラー文字列を探したいときに便利です。",
  collSourceDiff: "この spec に関連する差分",
  collSourceDiffHelp:
    "この spec が依存するファイル (relatedPaths) に絞り込んだ PR 差分です。今回の PR のコード変更が失敗の原因か、具体的にどの行が変わったかを確認するために開いてください。解析結果が SPEC_CHANGE / PRODUCT_BUG のとき、根拠はここに含まれているはずです。",
  collSpecYaml: "テスト定義 (spec.yaml)",
  collSpecYamlHelp:
    "オリジナルのテスト定義です。タイトル・各ステップ・期待結果が確認できます。テストコードが意図から乖離していないか、UI 変更後に spec を再起草する際の参照に便利です。",
  collDriftAudit: (n) => `spec と実装の差分監査 (${n})`,
  collDriftAuditHelp:
    "spec が期待している assertion と現在のソースコードを照合する読み取り専用の監査です。ERROR 行は「テストがコード上に存在しないものを assert している (TEST_DRIFT / SPEC_CHANGE)」のサインです。判定の補強材料として参照してください (確定的な結論ではありません)。",
};

const STRINGS: Record<ReportLocale, ReportStrings> = { en: EN, ja: JA };

/**
 * Normalise a BCP-47 / language hint to one of the locales we ship strings
 * for. Anything we don't recognise (including "auto" / null / undefined)
 * falls back to English.
 */
export function resolveReportLocale(lang: string | null | undefined): ReportLocale {
  if (!lang) return "en";
  const base = lang.toLowerCase().split(/[-_]/)[0] ?? "";
  return (SUPPORTED_LOCALES as readonly string[]).includes(base) ? (base as ReportLocale) : "en";
}

export function reportStrings(lang: string | null | undefined): ReportStrings {
  return STRINGS[resolveReportLocale(lang)];
}
