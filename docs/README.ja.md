# ccqa

**あなたの Claude サブスクリプションには、すでに QA エンジニアが含まれています。**

ccqa は Claude Code をブラウザテストのレコーダー兼ランナーに変えます。テスト仕様を
YAML で書くと、Claude が 1 度だけブラウザを操作して経路を発見し、ccqa がその記録を
選択した target のテストコード — vitest ベースの `test.spec.ts`、プレーンな
Playwright spec、runn の runbook — にコンパイルします。`ccqa run` がすべてを実行して
1 つのレポートにまとめ、共有 hub に push できます。追加の API キーは不要。
`claude` だけで動きます。

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

- **Deterministic**（デフォルト）: 1 度 record すれば CI では vitest で再生するだけ —
  実行時に LLM は介在せず、最も安価で安定。
- **Live**（`mode: live`）: codegen 不要。毎回 Claude がブラウザを操作し、各 step の
  `expected` を判定 — タイミング依存のフラジャイルな UI 向け。
- **その他の target**（`target: playwright` / `runn`）: 同じ記録（または spec 自体）を
  既存のテストスイートに組み込めるテストコードとして emit し、自前のコマンドで実行。
- 失敗した spec には原因分類（TEST_DRIFT / SPEC_CHANGE / PRODUCT_BUG）が付き、
  hub 上で採点できます — hub は採点から学習します。

## インストール

```bash
pnpm add -D ccqa vitest agent-browser
```

Node.js **20+** が必要です。
[agent-browser](https://github.com/vercel-labs/agent-browser) と
[vitest](https://vitest.dev) は peer dependency です。

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
ます。[ccqa hub](./hub.md) に push すると、結果の閲覧、失敗 triage の採点、CI との
セッション・変数共有ができ、CI が持つ secret は 1 つで済みます。フラグ・CI レシピ・
レポート形式は [Running specs](./running.md) を参照してください。

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
