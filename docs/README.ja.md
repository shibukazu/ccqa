# ccqa

> [!WARNING]
> ccqa は開発中です。破壊的変更が入ることがあります。

**Claude のサブスクリプションには、QA エンジニアがすでに含まれています。**

テスト仕様を YAML で書きます。Claude が実ブラウザを **1 度だけ**操作して
経路を見つけ、ccqa がその記録を普通のテストコードに変換します。CI はそれを
再生するだけで、モデルも API キーも使いません。Claude に頼るのは、頼る価値の
ある場面だけです。spec とコードの突き合わせ（監査）、失敗の原因分類、
`mode: live` の spec がそれにあたります。

[English README](../README.md)

## クイックスタート

```bash
pnpm add -D ccqa vitest agent-browser   # Node 20+
```

spec を書きます。`ccqa init` が骨組みを作り、[`ccqa draft`](./draft.md) は
対話しながら一緒に書いてくれます。

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

1 度だけ record して、あとは再生するだけです。

```bash
echo 'APP_URL=http://localhost:3000' >> .env   # 値は spec に書かない
ccqa record tasks/create-and-complete          # Claude がブラウザを操作
ccqa run tasks/create-and-complete             # vitest が再生。LLM は動かない
```

実行のたびに `report.json` と step ごとのスクリーンショットが
`ccqa-report/` に書き出されます。

record では再生できないログインもあります。SSO のリダイレクトやデバイス認証
です。その場合は [`ccqa hub session capture`](./sessions.md) で 1 度だけ手で
ログインしてください。以後の spec は、その保存済みセッションから始まります。

## 仕組み

```
spec.yaml ──► ccqa record ──► ir.json ──► テストコード ──► ccqa run
 steps +       Claude が        記録された    target ごとに     CI が再生、
 expected      ブラウザを操作   アクション    生成              LLM なし
```

spec の実行のしかたは 2 通りあります。

**Deterministic（既定）。** 記録がプレーンなテストコードに変換され、CI は
モデルなしでそれを再生します。`target:` が選ぶのは変換先だけです。

| `target:` | 生成ファイル | 再生手段 |
|---|---|---|
| `agent-browser`（既定） | `test.spec.ts`（vitest） | vitest |
| `playwright` | プレーンな `@playwright/test` spec | プロジェクトの `runCommand` |
| `runn` | `runbook.yaml`（API シナリオ。record 不要） | プロジェクトの `runCommand` |

**Live（`mode: live`）。** コード生成をせず、毎回 Claude がブラウザを操作して
各 step の `expected` を判定します。固定の記録では壊れてしまう UI 向けです。

vitest と agent-browser は既定ターゲットの peer dependency です。外部ターゲット
だけを使うプロジェクトは `ccqa` とそのツールだけで足ります。`runCommand` と
既存のページオブジェクトの再利用は [Generation targets](./targets.md) を参照
してください。

## 監査してから実行する

**spec は、検証環境で動いているコードを説明するものです。** 手元のブランチ
でも main の先端でもありません。デプロイでコードが変わると、説明できなく
なる spec が出ます。それは落ちるテストではなく、動いているものについて何も
正しいことを言わなくなったテストで、実行しても何も証明しません。

だから ccqa は、安い問いを高い問いより先に立てます。

```
         検証環境で動いているコード
                     │
                     │  spec はこれを説明している
                     ▼
        デプロイのコミットが変わる
                     │
                     ▼
      その変更が届く spec だけ監査
                     │
   まだ説明できている ─┴─ 説明できなくなった
          │                      │
          ▼                      ▼
       実行する            人が直す
                                 │
                        次の回で監査し直す。
                        それまでは未検証
```

`ccqa audit` が各 spec をソースと突き合わせます。1 spec 数セント、ブラウザ
不要です。判定はすべて **hub**（チームと CI が共有するものを置く小さな
サーバ）に記録されます。生成コードのずれは録り直しで直り、spec 自体のずれは
人が直すまで**未検証**のまま残ります。通ったのでも落ちたのでもない状態です。

`ccqa run --only-hub-rerun-needed` は、どの spec を走らせる価値があるかを
hub に聞きます。走るのは、監査が通し、*かつ*デプロイが無効化したものだけ
です。ずれた spec と、前回落ちた spec には `needsRepair` が返り、実行され
ません。どちらも実行しても直らず、それを知るのに数ドルかかるからです。

何も選ばれないことが答えになるのは、全 spec に答えが出たときだけです。監査
待ちの spec や hub が判定できなかった spec が残っていれば、**非ゼロで終了**
します。何も検証していない実行を緑として報告しないためです。また実行中は
spec を確保するので、前の周が終わる前に次が始まっても、同じ spec を二度
走らせることはありません。

アプリの外の同じ場所（チャットのチャンネル、共有の受信箱）に書き込む spec
は、`.ccqa/config.yaml` の
[`serialGroups`](./targets.md#serialgroups--specs-that-must-not-run-at-the-same-time)
に加えます。確保の対象はこのグループにも及ぶので、`--concurrency` で実行
時間を縮めても、2 つの spec が互いの結果を読んでしまうことはありません。
同じ実行の中でも、次の周との間でもです。

それでも落ちた spec には、`--on-fail-explain` が誰の担当かのラベルを付け
ます。`TEST_DRIFT`（テストのずれ）、`SPEC_CHANGE`（仕様変更）、
`PRODUCT_BUG`（プロダクトの不具合）、判断できなければ `UNKNOWN` です。
ラベルは hub 上で採点でき、hub はその採点から学習します。

## CI に組み込む

```
デプロイ完了
  ├─ ccqa hub deploy record --select   何が載ったか、どの spec に届くか
  ├─ ccqa audit --only-hub-audit-needed --report-to-hub
  │                                    spec はまだ説明できているか
  └─ ccqa run --only-hub-rerun-needed --on-fail-explain \
       --hub-profile ci --report-to-hub
```

監査は数セント、live の spec は数ドルです。先に絞れば、読む価値のある失敗
だけが残ります。デプロイは必ず `--select` 付きで記録してください。無しで
記録した範囲は永久に `unanswerable` と答え、後から埋める手段がありません。

| ジョブ | きっかけ | 答える問い |
|---|---|---|
| デプロイのループ | デプロイのあと | このデプロイはどの spec を無効化したか |
| マージ前の実行 | `pull_request` | この変更は spec を壊すか。誰の責任か |
| 全体監査 | 定期実行 | 全 spec はまだコードを説明しているか |

ループの外の 2 つのジョブはこうなります。

```bash
# pull request — 差分が届く spec を実行し、壊れた原因を分類
# (checkout は fetch-depth: 0。浅いと基準の ref が解決できない)
ccqa run --only-affected-by "origin/$GITHUB_BASE_REF" --on-fail-explain \
  --hub-profile ci --report-format github --report-to-hub

# 定期実行 — 全 spec を監査。ブラウザもデプロイも不要
ccqa audit --report-format github --report-to-hub
```

動くワークフローとフラグの一覧は
[CI integration](./running.md#ci-integration) にあります。

## hub

hub はここまでに 2 回登場しました。監査が判定を書き込む先であり、実行が
「どれを走らせる価値があるか」を聞く相手です。同じサーバが、チームで共有する
残りのものも持ちます。`${…}` が解決する変数と保存済みセッション（CI が持つ
secret は 1 つで済みます）、絞り込みフラグの裏にあるデプロイログ、スクリーン
ショット付きの実行レポート、採点から学習したプロンプトです。

```bash
export CCQA_HUB_TOKEN=$(openssl rand -hex 24)
export CCQA_HUB_ENCRYPTION_KEY=$(openssl rand -hex 32)
ccqa serve
```

hub が要るものは名前で分かります。`--hub-profile`、
`--only-hub-rerun-needed`、`--report-to-hub` がそれで、繋げないときは黙って
縮退せずエラーになります。**profile** は変数とセッションの名前付きの組
（テナント、アカウント、役割）であって、環境ではありません。ccqa が追跡する
検証環境は 1 つです
（[ADR-0013](./adr/0013-one-verification-environment.md)）。

## ドキュメント

| やりたいこと | 読むもの |
|---|---|
| spec を書く — フィールド、ブロック、ファイルアップロード | [spec.yaml](./spec.md) |
| spec を実行してレポートを読む | [Running](./running.md) |
| GitHub Actions に組み込む | [CI integration](./running.md#ci-integration) |
| Playwright / runn のテストを生成する | [Targets](./targets.md) |
| live モードで動かす | [Live specs](./live.md) |
| 1 度ログインしてセッションを使い回す | [Sessions](./sessions.md) |
| チームの hub を立てる・HTTP で操作する | [Hub](./hub.md) · [API](./hub-api.md) |
| なぜこの作りなのかを知る | [ADR](./adr/README.md) |

## ライセンス

MIT
