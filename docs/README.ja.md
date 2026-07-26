# ccqa

**あなたの Claude サブスクリプションには、すでに QA エンジニアが含まれています。**

ccqa は Claude Code をブラウザテストのレコーダー兼ランナーに変えます。テスト
仕様を YAML で書くと、Claude が実ブラウザを **1 度だけ**操作して経路を発見し、
ccqa がその記録を普通のテストコードにコンパイルします。以後の CI は、モデルを
介さずにそれを再生するだけです。

サブスクリプションが効いてくるのは record のときで、手元の `claude` があれば
追加の API キーは要りません。CI では不要になります — record 済みの spec は
プレーンなテストコードとして再生されるからです。Claude を使う任意の機能だけが
CI で資格情報を必要とします：[失敗分類と drift](#失敗分類と-drift)、
[変更範囲の選択](#ci-に組み込む)、そして `mode: live` の spec です。

[English README](../README.md)

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

**2. `${APP_URL}` が何かを教える。** spec は環境そのものを埋め込まず変数名を
書きます。同じ spec をローカルにも staging にも向けられるようにするためです。
ローカルは `.env` で足り、CI では値を hub から取ります（`ccqa hub var set`）。
環境固有の値をリポジトリに置かないためです。詳細は
[Profiles and environment variables](./running.md#profiles-and-environment-variables)。

```bash
echo 'APP_URL=http://localhost:3000' >> .env
```

**3. 1 度だけ record** — Claude がブラウザを操作し、テストを生成します:

```bash
ccqa record tasks/create-and-complete
```

**4. 実行する** — vitest が記録を再生します。LLM は介在しません:

```bash
ccqa run tasks/create-and-complete
```

`report.json`（＋step ごとのスクリーンショット）が常に `ccqa-report/` に書き
出されます。フラグとレポート形式は [Running specs](./running.md) を参照して
ください。

SSO リダイレクトやデバイス信頼ゲートのように、record では再現できないログインの
先にある spec の場合は、[`ccqa session bootstrap`](./sessions.md) で 1 度だけ
手作業でセッションを保存し、spec からその名前を参照します。

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
`pnpm exec playwright test {files}`。代入の仕様は
[Generation targets](./targets.md) を参照してください。

**Live（`mode: live`）。** codegen なし: 毎回 Claude がブラウザを操作し、
各 step の `expected` を判定します — 固定の記録では壊れてしまう、
タイミング依存のフラジャイルな UI 向け。

## 失敗分類と drift

E2E テストが落ちても、それが誰の問題なのかは分かりません。ccqa はこれを
1 つの語彙で、2 方向から答えます。

**spec が失敗したとき**、`ccqa run --failure-analysis [base]` が原因を分類
します — `TEST_DRIFT` / `SPEC_CHANGE` / `PRODUCT_BUG`、そして根拠が判断を
支えないときは `UNKNOWN`。分類には同じ spec の drift 監査が伴います。
「テストが壊れたのか」と「テストはまだプロダクトを説明しているか」は同じ
調査だからです。`[base]` は差分を読む基準で、git の ref か、`last-green`
（各 spec が最後に成功したコミットを基準にする）を指定します。どちらも
無い場合は失敗そのものだけを根拠に分類し、その旨を明示します。

**何かを実行する前には**、`ccqa drift` が 2 つ目の問いだけをブラウザなしで
問います — 各 spec はまだコードを説明しているか。deterministic な spec では
「人が書いた spec」と「そこからコンパイルされたテストコード」の両方を見ます。
どちらもずれうるからです。どちらがずれたかで直し方が決まるので、監査はそれを
報告します：生成コードのずれは record し直し、spec のずれは人が書き直します。

すべての判断は hub 上で採点でき、hub は採点から学習します。詳細は
[Failure triage](./running.md#failure-triage) と
[Drift detection](./running.md#drift-detection)。

## CI に組み込む

3 つのジョブが、それぞれ別の問いに答えます。いずれも hub の secret 1 つと
Claude の資格情報 1 つで足ります。
[Environment variables](./commands.md#environment-variables) を参照。

**プルリクエストで** — 変更が到達する spec だけを再生し、壊れた理由を説明する:

```bash
ccqa run --changed --failure-analysis --format github --push-report
```

`--changed` は差分と spec の棚卸しを読み、spec ごとに「この変更が到達するか」
を判定します。E2E の spec からプロダクトコードへの静的な依存辺は存在しないので、
シロだと言い切れない spec は実行されます。`unknown` を「安全」として黙って
扱うことはありません。選択結果だけ見て課金を避けたいときは `--dry-run` を
足します。

**デプロイのたびに** — 何が出荷されたかを記録し、次回の実行が「どれがまだ
信用できるか」を判定できるようにする:

```bash
ccqa hub deploy record --profile staging --sha "$GITHUB_SHA" --select
```

以後 `ccqa run --changed=last-run --profile staging` は、各 spec が最後に
実行されて以降に触られたものだけを再生します。各 spec の基準点はデプロイログ上
の別々の位置にあるため、判定は後から計算するのではなくデプロイと一緒に記録
します。`--select` が無いと hub は `unknown` と答えるしかありません。

**定期実行、または main への push で** — ブラウザを一切使わずに spec を
コードと突き合わせ、人手が要るものだけ通知する:

```bash
ccqa drift --changed --base "$BEFORE_SHA" --format json --push
```

`--push` は各判定を spec ごとの台帳に畳み込みます。hub は実行結果の隣に
それを表示するので、どのケースがずれているかが一目で分かります。

3 つとも動く GitHub Actions のワークフローは
[CI integration](./running.md#ci-integration) と
[GitHub Actions example](./hub.md#github-actions-example) にあります。

## hub

1 人が 1 台で使うなら hub は任意です。チームで使う場合と CI では、共有状態の
置き場になります — ほかに置く場所はありません:

- 何がテストされているかの棚卸し
  （[perspectives](./spec.md#inventory-coverage-with-perspectives)）—
  `record`/`generate` のたびに最新化
- `${…}` が解決する変数と、保存済みブラウザセッション（実行時に取得）—
  CI が持つのは環境ではなく secret 1 つで済む
- `--changed=last-run` の裏にあるデプロイログと、drift の台帳
- step ごとのスクリーンショット付き実行ダッシュボード、triage 採点、
  その採点から学習したプロンプト

```bash
export CCQA_HUB_TOKEN=$(openssl rand -hex 24)
export CCQA_HUB_ENCRYPTION_KEY=$(openssl rand -hex 32)   # セッションと変数の
ccqa serve                                               # 保存に必要
```

コンテナ配備用の `Dockerfile` と `docker-compose.yaml` はリポジトリのルートに
あります。clone するか、
[Running the hub in a container](./hub.md#running-the-hub-in-a-container)
から写してください。npm パッケージには含まれません。

詳細は [Hub](./hub.md)、HTTP で操作する場合は [Hub API](./hub-api.md)。

## ドキュメント

各詳細ドキュメントは英語版のみです。

| やりたいこと | ドキュメント |
|---|---|
| コマンドや環境変数を引く | [Command reference](./commands.md) |
| 仕様を書く: フィールド・再利用ブロック・ファイルアップロード・カバレッジ棚卸し | [spec.yaml reference](./spec.md) |
| Claude と対話しながら仕様を書く | [Draft](./draft.md) |
| 既存のテスト資産を再利用する Playwright / runn テストを生成する | [Generation targets](./targets.md) |
| spec を実行してレポートを読む | [Running specs](./running.md) |
| 失敗を分類して判断を採点する | [Failure triage](./running.md#failure-triage) |
| 実行せずに spec とコードのずれを監査する | [Drift detection](./running.md#drift-detection) |
| 変更が到達する spec だけを再生する | [Scoping with `--changed`](./running.md#scoping-with---changed) |
| GitHub Actions に組み込む | [CI integration](./running.md#ci-integration) |
| live で spec を実行する（codegen なし）・プロジェクト別ガイダンス | [Live specs](./live.md) |
| サインイン済みで実行を始める / デバイス信頼ゲートを回避する | [Saved sessions](./sessions.md) |
| 生成テストが使うアサーションを知る | [Assertions](./assertions.md) |
| 失敗した記録済みテストを自動修正する | [Auto-fix](./auto-fix.md) |
| 実行結果・セッション・変数をチームのサーバーに集約する | [Hub](./hub.md) |
| hub を HTTP で操作する | [Hub API](./hub-api.md) |
| なぜこの設計なのかを知る | [ADR](./adr/README.md) |

## ライセンス

MIT
