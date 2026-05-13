# ccqa

**あなたの Claude サブスクリプションには、すでに QA エンジニアが含まれています。**

ccqa は Claude Code をブラウザテストレコーダーに変えます。Markdown で仕様を書き、`ccqa trace` を実行すると、Claude が [agent-browser](https://github.com/vercel-labs/agent-browser) を介してアプリを操作します。すべての操作が記録され、CI で実行できる決定論的なテストスクリプトにコンパイルされます。追加の API キーは不要。`claude` だけで動きます。

[English README](../README.md)

## 仕組み

```mermaid
flowchart LR
    A["仕様を書く\n(test-spec.md)"] --> B["ccqa trace\n(Claudeがブラウザ操作)"]
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

```markdown
<!-- .ccqa/features/tasks/test-cases/create-and-complete/test-spec.md -->
---
title: タスクを作成して完了にする
baseUrl: http://localhost:3000
---

## Steps

### Step 1: ログイン
- **Instruction**: メールアドレスとパスワードを入力してフォームを送信
- **Expected**: /dashboard にリダイレクトされ、ヘッダーにユーザーアバターが表示される

### Step 2: タスクを作成
- **Instruction**: "New Task" をクリックし、タイトル "Fix login bug" を入力、優先度を High に設定して保存
- **Expected**: タスク一覧に "Open" ステータスで表示される
```

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

## 機能

各詳細ドキュメントは英語版です。

| 機能 | ドキュメント |
|---|---|
| Claude と対話しながら仕様を書く | [Draft](./draft.md) |
| ログインなどのセットアップ手順を使い回す | [Setup Specs](./setup-specs.md) |
| アサーションヘルパー関数 | [Assertions](./assertions.md) |
| 失敗したテストを自動修正 | [Auto-fix](./auto-fix.md) |
| CI で仕様とコードのズレを検出 | [Drift](./drift.md) |

## コマンド

```
ccqa draft [feature/spec]          Claude と一緒にテスト仕様を作成
ccqa drift [feature/spec]          仕様 ↔ コードベースのドリフトをチェック (CI 向け)
ccqa trace <feature/spec>          ブラウザ操作を記録
ccqa generate <feature/spec>       記録された操作からテストスクリプトを生成
ccqa run [feature/spec]            生成されたテストスクリプトを実行
ccqa trace-setup <name>            setup spec のブラウザ操作を記録
ccqa generate-setup <name>         setup テストスクリプトを生成・検証
```

すべての Claude 駆動コマンドは `-m, --model <name>` を受け付けます (`sonnet` | `opus` | `haiku` のエイリアス、またはフルモデル ID)。このフラグは `CCQA_MODEL` 環境変数を上書きします。両方とも未設定の場合は Claude Code CLI のデフォルトが使われます。対話型コマンドはローカルの Claude Code ログインで認証します。`ccqa drift` は CI 向けに `ANTHROPIC_API_KEY` も受け付けます。

`<feature/spec>` は `.ccqa/features/<feature>/test-cases/<spec>/` への 2 セグメントのエイリアスです。

## ファイル構成

```
.ccqa/
  setups/
    login/
      setup-spec.md              # プレースホルダ付きの setup 定義
      test.spec.ts               # 生成された setup スクリプト
  features/
    tasks/
      test-cases/
        create-and-complete/
          test-spec.md           # テスト定義
          actions.json           # trace で記録された操作
          test.spec.ts           # 生成されたテストスクリプト
```

## ライセンス

MIT
