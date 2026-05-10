export interface SleepInsert {
  kind: "insert";
  line: number;
  seconds: number;
  reason: string;
}

export interface SleepIncrease {
  kind: "increase";
  line: number;
  increase_to: number;
  reason: string;
}

export type SleepFix = SleepInsert | SleepIncrease;

export interface TimingIssue {
  type: "TIMING_ISSUE";
  fixes: SleepFix[];
}

export interface OverAssertion {
  type: "OVER_ASSERTION";
  lines: number[];
  reason: string;
}

export interface SelectorDrift {
  type: "SELECTOR_DRIFT";
  line: number;
  oldSelector: string;
  newSelector: string;
  reason: string;
}

export interface DataMissing {
  type: "DATA_MISSING";
  reason: string;
}

export interface UnknownDiagnosis {
  type: "UNKNOWN";
  reason: string;
}

export type Diagnosis =
  | TimingIssue
  | OverAssertion
  | SelectorDrift
  | DataMissing
  | UnknownDiagnosis;

export interface DiagnosisResult {
  diagnosis: Diagnosis;
  confidence: number;
  reasoning: string;
}

export type FixOutcome =
  | { applied: true; script: string; summary: string }
  | { applied: false; reason: string };
