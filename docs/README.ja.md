# ccqa

**あなたの Claude サブスクリプションには、すでに QA エンジニアが含まれています。**

ccqa は Claude Code をブラウザテストレコーダーに変えます。YAML で仕様を書き、`ccqa trace` を実行すると、Claude が [agent-browser](https://github.com/vercel-labs/agent-browser) を介してアプリを操作します。すべての操作が記録され、CI で実行できる決定論的なテストスクリプトにコンパイルされます。追加の API キーは不要。`claude` だけで動きます。

[English README](../README.md)

## 仕組み

```mermaid
flowchart LR
    A["仕様を書く\n(spec.yaml)"] --> B["ccqa trace\n(Claudeがブラウザ操作)"]
    B --> C["ccqa generate\n(LLM → テストスクリプト)"]
    C --> D["ccqa run\n(決定論的な再生)"]
```

`trace` は仕様を渡して Claude Code を起動します。Claude は一歩ずつブラウザを操作し、すべての操作を構造化データとして記録します。`generate` はそのデータを vitest 互換のスクリプトにコンパイルします。`run` はそれを決定論的に再生します — LLM は介在しません。

## インストール

```bash
pnpm add -D ccqa vitest agent-browser
```

Node.js **20+** が必要です。[agent-browser](https://github.com/vercel-labs/agent-browser) は peer dependency です。

## クイックスタート

**1. 仕様を書く** — 手書き、または対話的に [`ccqa draft`](./draft.md) で

```yaml
# .ccqa/features/tasks/test-cases/create-and-complete/spec.yaml
title: タスクを作成して完了にする

steps:
  - instruction: |
      ${APP_URL}/login を開く。メールアドレスとパスワードを入力してフォームを送信する。
    expected: /dashboard にリダイレクトされ、ヘッダーにユーザーアバターが表示される

  - instruction: |
      "New Task" をクリックし、タイトル "Fix login bug" を入力、優先度を High に設定して保存
    expected: タスク一覧に "Open" ステータスで表示される
```

URL は `instruction` 内に直接書きます。環境ごとに切り替えたい値は `${ENV_VAR}` で参照します。

**2. Trace** — Claude がブラウザを操作し、すべての操作を記録

```bash
ccqa trace tasks/create-and-complete
```

**3. Generate** — 記録された操作を再生可能なテストに変換

```bash
ccqa generate tasks/create-and-complete
```

**4. Run** — LLM なしで決定論的に再生

```bash
ccqa run tasks/create-and-complete
```

CI で HTML 実行レポートを出力したい場合は `--drift-report` を付けます。失敗した spec ごとにドリフト監査と、PR 差分をコンテキストにした原因分類 (TEST_DRIFT / SPEC_CHANGE / PRODUCT_BUG) が付き、レポート上で人が正解を入力すると分類精度 (混同行列) をその場で計測できます。分析には `ANTHROPIC_API_KEY` か Claude Code のログインが必要です。詳細は [Run report](./report.md)。

```bash
ccqa run tasks/create-and-complete --drift-report --drift-base origin/main
```

## 機能

各詳細ドキュメントは英語版です。

| 機能 | ドキュメント |
|---|---|
| Claude と対話しながら仕様を書く | [Draft](./draft.md) |
| ログインなど共通手順を使い回す | [Blocks](./blocks.md) |
| アサーションヘルパー関数 | [Assertions](./assertions.md) |
| 失敗したテストを自動修正 | [Auto-fix](./auto-fix.md) |
| CI で仕様とコードのズレを検出 | [Drift](./drift.md) |
| 失敗原因分類つき HTML 実行レポート | [Run report](./report.md) |
| 既存のテストカバレッジを棚卸し | [Perspectives](./perspectives.md) |
| 設計判断の記録 (なぜこの設計か) | [ADR](./adr/README.md) |

## コマンド

```
ccqa draft [feature/spec]          Claude と一緒にテスト仕様を作成
ccqa trace <feature/spec>          spec のブラウザ操作を記録 (include した block はインライン展開して一緒に記録)
ccqa generate <feature/spec>       記録された操作から spec のテストスクリプトを生成
ccqa run [feature/spec]            生成されたテストスクリプトを実行 (--drift-report で失敗分析つき HTML レポート)
ccqa drift [feature/spec]          単独の仕様 ↔ コードベース監査 (定期ジョブ用)
ccqa perspectives                  既存のテストカバレッジを .ccqa/perspectives.yaml に棚卸し
```

すべての Claude 駆動コマンドは `-m, --model <name>` を受け付けます (`sonnet` | `opus` | `haiku` のエイリアス、またはフルモデル ID)。このフラグは `CCQA_MODEL` 環境変数を上書きします。両方とも未設定の場合は Claude Code CLI のデフォルトが使われます。また `--language <bcp47>` (例: `ja`、`en`) で人間向け出力の言語を指定できます。デフォルトの `auto` は spec / コードベースの言語に追従します。対話型コマンドはローカルの Claude Code ログインで認証します。CI で Claude を使うコマンド (`ccqa run --drift-report`、`ccqa drift`) は `ANTHROPIC_API_KEY` も受け付けます。

`<feature/spec>` は `.ccqa/features/<feature>/test-cases/<spec>/` への 2 セグメントのエイリアスです。

## ファイル構成

```
.ccqa/
  perspectives.yaml              # 既存カバレッジの棚卸し (機械可読・正)
  perspectives.md                # カテゴリ一覧インデックス (YAML から再生成)
  blocks/
    login/
      spec.yaml                  # 再利用可能なブロック (params + steps)
  features/
    tasks/
      perspectives.md            # カテゴリ単位の詳細テーブル (ケースごと)
      test-cases/
        create-and-complete/
          spec.yaml              # テスト定義
          actions.json           # trace で記録された操作
          test.spec.ts           # 生成されたテストスクリプト
```

## ライセンス

MIT
