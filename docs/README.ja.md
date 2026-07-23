# ccqa

**あなたの Claude サブスクリプションには、すでに QA エンジニアが含まれています。**

ccqa は Claude Code をブラウザテストのレコーダー兼ランナーに変えます:

1. テスト仕様を YAML で書く — 素朴な steps と expected の列。
2. Claude が実ブラウザを **1 度だけ**操作して経路を発見する（`ccqa record`）。
3. ccqa がその記録を `target:` のテストコードにコンパイルする —
   vitest リプレイ、プレーンな Playwright、runn の runbook。
4. `ccqa run` がすべてを再生して 1 つのレポートにまとめ、共有 hub に
   push できる。

追加の API キーは不要。`claude` だけで動きます。

[English README](../README.md)

## 仕組み

```
spec.yaml ──► ccqa record ─────► ir.json ────► ccqa generate ──► テストコード
 steps +       Claude がブラウザ   記録された     target ごとの      agent-browser
 expected      を操作し経路を      アクションの    emit               / playwright
               発見               ツール中立 IR   (reuse-first)      / runn

テストコード ─► ccqa run ───────► report.json ─► ccqa hub push /
               vitest 再生 /      + evidence      --push-report
               runCommand /       + artifacts     チームダッシュボード、
               live (Claude が                    失敗 triage、
               毎回操作)                          採点と学習
```

spec の実行様式は 2 つです:

**Deterministic（デフォルト）。** Claude がブラウザを 1 度だけ操作し
（`ccqa record`）、その記録がプレーンなテストコードにコンパイルされます。
以後の CI はそのコードを再生するだけ — 実行時に LLM は介在せず、最も安価で
安定。`target:` は「記録を**どの形式のコードにコンパイルするか**」だけを
選ぶもので、どの target も同じ deterministic な再生です:

| `target:` | 生成ファイル | 再生手段 |
|---|---|---|
| `agent-browser`（既定） | `test.spec.ts`（vitest + agent-browser） | vitest |
| `playwright` | `test.spec.ts`（プレーンな `@playwright/test`） | あなたの `runCommand` |
| `runn` | `runbook.yaml`（API シナリオ — spec から直接生成、record 不要） | あなたの `runCommand` |

`runCommand` は「そのリポジトリで普段そのツールを実行するコマンド」を
`.ccqa/config.yaml` に 1 行宣言するものです — 例:
`pnpm exec playwright test {files}`。`{files}` には spec の生成テスト
ファイルが、`{artifactsDir}` には spec ごとの成果物ディレクトリが ccqa に
よって代入されます。完全な仕様は [Generation targets](./targets.md)。

**Live（`mode: live`）。** codegen なし: 毎回 Claude がブラウザを操作し、
各 step の `expected` を判定します — 固定の記録では壊れてしまう、
タイミング依存のフラジャイルな UI 向け。

どちらの様式でも、そして `target:` が何であっても、
`ccqa run --failure-analysis [base]` でオプトインすると、失敗した spec に
`[base]` 以降のソース差分を根拠とした原因分類（TEST_DRIFT / SPEC_CHANGE /
PRODUCT_BUG）が付き、hub 上で採点できます — hub は採点から学習します。

## インストール

```bash
pnpm add -D ccqa vitest agent-browser
```

Node.js **20+** が必要です。
[agent-browser](https://github.com/vercel-labs/agent-browser) と
[vitest](https://vitest.dev) は**デフォルトの agent-browser ターゲット**の
peer dependency です（記録したテストの実行に使われます）。外部ターゲット
（`playwright` / `runn`）だけを使うプロジェクトは `ccqa` とそのツールだけで
足ります（例: `pnpm add -D ccqa @playwright/test`）。ccqa はターゲットの
`runCommand` 経由で実行します。

## クイックスタート

**1. 仕様を書く** — 手書き、または対話的に [`ccqa draft`](./draft.md) で
（`.ccqa/` の骨組みは `ccqa init` が作成します）:

```yaml
# .ccqa/features/tasks/test-cases/create-and-complete/spec.yaml
title: タスクを作成して完了にする

steps:
  - instruction: |
      ${APP_URL}/login を開く。メールアドレスとパスワードを入力してフォームを送信する。
    expected: /dashboard にリダイレクトされ、ヘッダーにユーザーアバターが表示される

  - instruction: |
      "New Task" をクリックし、タイトル "Fix login bug" を入力して保存する。
    expected: タスク一覧に "Open" ステータスで表示される
```

**2. 1 度だけ record** — Claude がブラウザを操作し、テストを生成します:

```bash
ccqa record tasks/create-and-complete
```

**3. 実行する** — vitest が記録を再生します。LLM は介在しません:

```bash
ccqa run tasks/create-and-complete
```

`report.json`（＋step ごとのスクリーンショット）が常に `ccqa-report/` に書き出され
ます。フラグ・CI レシピ・レポート形式は [Running specs](./running.md) を参照して
ください。

**4. 任意: hub で結果を共有する** — `ccqa serve` でセルフホストの小さな
サーバーが立ちます（同梱の `docker-compose.yaml` でも可）。レポートを push
するとチームで次のことができます:

- 実行結果のダッシュボード（step ごとのスクリーンショット付き）
- テスト観点の一覧
  （[perspectives](./spec.md#inventory-coverage-with-perspectives)）—
  `record`/`generate` のたびに自動で最新化
- 失敗 triage の採点 — 分類の正誤をマークすると hub が採点から学習
- 保存済みセッション・変数・学習プロンプトの一元管理 — CI が持つ secret は
  1 つで済む

```bash
export CCQA_HUB_TOKEN=$(openssl rand -hex 24)
ccqa serve                                  # または docker compose up -d
ccqa run tasks/create-and-complete --push-report \
  --hub-url http://localhost:8787 --hub-token $CCQA_HUB_TOKEN
```

詳細（暗号化・コンテナ配備・HTTP API）は [Hub](./hub.md) を参照してください。

## ドキュメント

各詳細ドキュメントは英語版のみです。

| やりたいこと | ドキュメント |
|---|---|
| 仕様を書く: フィールド・再利用ブロック・ファイルアップロード・カバレッジ棚卸し | [spec.yaml reference](./spec.md) |
| Claude と対話しながら仕様を書く | [Draft](./draft.md) |
| 既存のテスト資産を再利用する Playwright / runn テストを生成する | [Generation targets](./targets.md) |
| spec の実行・レポート・失敗 triage・drift 検出・CI 組み込み | [Running specs](./running.md) |
| live で spec を実行する（codegen なし）・プロジェクト別ガイダンス | [Live specs](./live.md) |
| サインイン済みで実行を始める / デバイス信頼ゲートを回避する | [Saved sessions](./sessions.md) |
| 生成テストが使うアサーションを知る | [Assertions](./assertions.md) |
| 失敗した記録済みテストを自動修正する | [Auto-fix](./auto-fix.md) |
| 実行結果・セッション・変数をチームのサーバーに集約する | [Hub](./hub.md) |
| hub を HTTP で操作する | [Hub API](./hub-api.md) |
| なぜこの設計なのかを知る | [ADR](./adr/README.md) |

## ライセンス

MIT
