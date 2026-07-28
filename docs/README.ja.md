# ccqa

> [!WARNING]
> ccqa は開発中です。破壊的変更が入ることがあります。

**Claude のサブスクリプションには、QA エンジニアがすでに含まれています。**

ccqa は Claude Code をブラウザテストのレコーダー兼ランナーとして使えるように
します。テスト仕様を YAML で書くと、Claude が実ブラウザを **1 度だけ**操作して
経路を見つけ、ccqa がその記録を普通のテストコードに変換します。あとは CI が
そのコードを再生するだけで、実行時にモデルは動きません。

サブスクリプションが効くのは record のときです。手元に `claude` があれば追加の
API キーは要りません。CI では記録済みのコードを再生するだけなので、そもそも
Claude を使いません。資格情報が必要になるのは Claude を使う機能を有効にした
ときだけで、[監査と失敗分類](#監査してから実行する)、
[変更範囲の選択](#ci-に組み込む)、`mode: live` の spec がこれにあたります。

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

**1. 仕様を書く。** 手書きでも、[`ccqa draft`](./draft.md) で Claude と
対話しながらでも構いません（`.ccqa/` の骨組みは `ccqa init` が作ります）。

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

**2. `${APP_URL}` の値を用意する。** spec には環境そのものではなく変数名を
書きます。同じ spec をローカルにも staging にも向けられるようにするためです。
ローカルなら `.env` に書けば足ります。CI では hub に登録した値を実行時に取得
するので（`ccqa hub var set`）、環境ごとの値をリポジトリに置かずに済みます。
[Profiles and environment variables](./running.md#profiles-and-environment-variables)
を参照してください。

```bash
echo 'APP_URL=http://localhost:3000' >> .env
```

**3. 1 度だけ record する。** Claude がブラウザを操作し、テストを生成します。

```bash
ccqa record tasks/create-and-complete
```

**4. 実行する。** vitest が記録を再生します。LLM は動きません。

```bash
ccqa run tasks/create-and-complete
```

`report.json`（＋step ごとのスクリーンショット）が常に `ccqa-report/` に書き
出されます。フラグとレポート形式は [Running specs](./running.md) を参照して
ください。

SSO のリダイレクトやデバイス認証のように、record では再現できないログインの
先に spec がある場合は、[`ccqa hub session capture`](./sessions.md) で 1 度だけ
手作業でログインしてセッションを保存し、spec からその名前を参照します。

## 仕組み

```
spec.yaml ──► ccqa record ─────► ir.json ────► ccqa generate ──► テストコード
 steps +       Claude がブラウザ   記録された     target ごとの      agent-browser
 expected      を操作し経路を      アクションの    emit               / playwright
               発見               ツール中立 IR   (reuse-first)      / runn

テストコード ─► ccqa run ───────► report.json ─► ccqa hub push /
               vitest 再生 /      + evidence      --report-to-hub
               runCommand /       + artifacts     チームダッシュボード、
               live (Claude が                    失敗 triage、
               毎回操作)                          採点と学習
```

spec の実行のしかたは 2 通りあります。

**Deterministic（既定）。** Claude がブラウザを 1 度だけ操作し（`ccqa
record`）、その記録がプレーンなテストコードに変換されます。以後の CI はその
コードを再生するだけなので、実行時に LLM は動かず、最も安価で安定します。
`target:` が選ぶのは記録を**どの形式のコードに変換するか**だけで、どの target
でも再生そのものは同じです。

| `target:` | 生成ファイル | 再生手段 |
|---|---|---|
| `agent-browser`（既定） | `test.spec.ts`（vitest + agent-browser） | vitest |
| `playwright` | `test.spec.ts`（プレーンな `@playwright/test`） | プロジェクトの `runCommand` |
| `runn` | `runbook.yaml`（API シナリオ。spec から直接生成し、record は不要） | プロジェクトの `runCommand` |

`runCommand` には、そのリポジトリで普段そのツールを実行しているコマンドを
`.ccqa/config.yaml` に 1 行書きます（例: `pnpm exec playwright test {files}`）。
置換の仕様は [Generation targets](./targets.md) を参照してください。

**Live（`mode: live`）。** コード生成をしません。毎回 Claude がブラウザを
操作し、各 step の `expected` を判定します。固定の記録ではすぐ壊れてしまう、
タイミングに左右されやすい UI 向けです。

## 監査してから実行する

**spec は、検証環境で動いているコードを説明するものです。** 手元のブランチの
コードでも、デフォルトブランチの先端でもなく、いま検証しているデプロイそのもの。
以下はすべて、この 1 文から出てきます。

デプロイでそのコードが変わると、説明できなくなる spec が出ます。これは**落ちる
テストではなく、動いているものについて何も正しいことを言わなくなったテスト**です。
実行しても何も分かりません。それを問うのが監査で、**何かを実行する前に答えを
出します。**

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
       実行する            spec を書き換える
                                 │
                        次の回で監査し直す。
                        それまでは未検証
```

監査するのは変更が届いた spec だけ、実行するのはまだ説明できている spec だけです。
直し待ちの spec は**通ったのでも落ちたのでもなく、未検証**であり、そう報告されます。

**まずブラウザを使わずに、各 spec がまだコードを説明しているかを見ます。**
`ccqa audit` が spec とソースを突き合わせます。deterministic な spec では、
人が書いた spec と、そこから生成されたテストコードの両方を見ます。どちらもずれ
うるからです。どちらがずれたかで直し方が変わるので、監査はそれも報告します。
生成コードのずれは record し直せば済み、spec のずれは人が書き直す必要があります。
1 spec あたり数セント、環境も要りません。

**次に、監査が通した spec を実行します。それでも落ちたものについては、誰の担当
かまで踏み込みます。** E2E テストは、落ちただけではそれを教えてくれません。
`ccqa run --only-hub-audited-clean --on-fail-explain` は、監査でズレが見つからな
かった spec だけを実行し、失敗を `TEST_DRIFT`（テストのずれ）、`SPEC_CHANGE`
（仕様変更）、`PRODUCT_BUG`（プロダクトの不具合）に分類します。根拠が足りず
判断できないときは `UNKNOWN` です。差分を読む基準は、各 spec が最後に成功した
コミットで、hub から取得します。`--on-fail-explain-base <ref>` を渡すと、代わりに
指定した 1 つの ref を基準にします。基準を hub に置けない環境で使います。

**この順序が、高いほうの工程を払う価値を作ります。** 監査が指摘した spec は、
すでに伝えられている理由で落ちます。それをもう一度確かめるのに、静的な読解では
なく実ブラウザの実行を使うことになる。先に絞れば、残った失敗は読むだけでは
捕まえられなかったものだけになります。

一度も監査していない spec も実行しません。`--only-hub-audited-clean` は判定に
従って動くフラグで、「まだ見ていない」は判定ではないからです。

いずれの判断も hub 上で採点でき、hub はその採点から学習します。詳細は
[Failure triage](./running.md#failure-triage) と
[Drift detection](./running.md#drift-detection) を参照してください。

## hub

1 人が 1 台で使うぶんには hub は任意です。チームで使う場合と CI では、次の
共有状態の置き場になります。ほかに置ける場所はありません。

- 何がテストされているかの棚卸し
  （[perspectives](./spec.md#inventory-coverage-with-perspectives)）。
  `record` と `generate` のたびに最新化されます
- `${…}` が解決する変数と、保存済みのブラウザセッション。実行時に取得するので、
  CI が持つのは環境一式ではなく secret 1 つで済みます
- `--only-hub-stale` の判定に使うデプロイログと、drift の台帳
- step ごとのスクリーンショット付きの実行ダッシュボード、triage の採点、
  その採点から学習したプロンプト

```bash
export CCQA_HUB_TOKEN=$(openssl rand -hex 24)
export CCQA_HUB_ENCRYPTION_KEY=$(openssl rand -hex 32)   # セッションと変数の
ccqa serve                                               # 保存に必要
```

**hub が要るものは名前に hub が入ります。** `--hub-profile`、
`--only-hub-stale`、`--only-hub-audited-clean`、`--learn-hub-live-prompt`、
`--report-to-hub` がそれで、hub に繋げないときはエラーになります。hub 由来の
絞り込みを頼んだのに黙って全件走る、送信を頼んだのに黙って送られない、
どちらも止める価値があるからです。

コンテナで動かすための `Dockerfile` と `docker-compose.yaml` はリポジトリの
ルートにあります。npm パッケージには含まれないので、clone するか
[Running the hub in a container](./hub.md#running-the-hub-in-a-container)
から写してください。

詳細は [Hub](./hub.md) を、HTTP で操作する場合は [Hub API](./hub-api.md) を
参照してください。

## CI に組み込む

**監査してから、監査が通したものを実行する。** これが CI における ccqa の
全体像です。

```
デプロイ完了
  │
  ├─ ccqa hub deploy record --select     何が載ったか、どの spec に届くか
  │
  ├─ ccqa audit --report-to-hub          spec はまだコードを説明しているか
  │                                      静的・ブラウザ不要・1 本数セント
  │
  └─ ccqa run --only-hub-audited-clean --only-hub-stale --on-fail-explain
                                         監査が通し、かつデプロイが無効化した
                                         spec だけを実行
```

監査は数セント、live の spec は数ドルです。監査が指摘済みの spec を実行するのは、
安いほうが既に知っていることを高いほうで見つけ直すことにあたります。しかも出て
くる失敗は、先に伝えられていたズレそのもので、新しい情報ではありません。先に
絞れば、読む価値のある失敗だけが残ります。

このループの外に 2 つジョブが立ちます。`pull_request` の実行はマージ前に壊れを
捕まえ、定期監査はデプロイ経路が通らない spec を拾います。

| ジョブ | きっかけ | 答える問い |
|---|---|---|
| デプロイのループ | デプロイのあと | 通っている spec のうち、このデプロイが無効化したのはどれか |
| マージ前の実行 | `pull_request` | この変更は spec を壊すか。壊したのは誰の責任か |
| 全体監査 | 定期実行 | spec はまだコードを説明しているか |

どれも、次の 2 つが必要です。

- **Claude の資格情報。** 記録済み spec の再生自体はモデルを使いませんが、
  変更範囲の選択、失敗分類、監査はどれも使います。
- **稼働中の [hub](#hub)。** `CCQA_HUB_URL` と `CCQA_HUB_TOKEN` で接続します。
  hub なしで済むのは、`--hub-profile` も `--report-to-hub` も付けないマージ前の実行
  だけです。

一覧は [Environment variables](./commands.md#environment-variables) にあります。

**profile** は hub 上の変数と保存済みセッションの、名前を付けた組です。テナント、
アカウント、役割といったものを指します。**環境ではありません。**

開発中はどこに向けても構いませんが、ccqa が*追跡する*のは検証環境 1 つです。
テストコードは 1 バージョンしかなく、記述できるデプロイも 1 つだからです。監査も
再実行判定も、問うているのはその 1 つについてです。spec が参照する変数は、手元から
一度だけ登録します。

```bash
ccqa hub var set APP_URL --value https://app.example --profile ci
```

どのジョブでも同じ `--hub-profile` と `--project` を渡してください。ジョブどうしが
同じ環境を指すのはこれによります。

### プルリクエストで

変更が到達する spec を実行し、壊れた原因を分類します。

```bash
ccqa run --only-affected-by "origin/$GITHUB_BASE_REF" --on-fail-explain \
  --hub-profile ci --report-format github --report-to-hub
```

- `--only-affected-by <ref>`：`<ref>` との差分が到達する spec を選びます。
  シロと判定できなかった spec は実行します。
- `--on-fail-explain`：失敗した spec の原因を分類します。
- `--hub-profile ci`：その profile の変数と保存済みセッションを hub から取得します。
  付けないと spec の `${…}` が解決されません。
- `--report-format github`：プルリクエストに注釈を付けます。
- `--report-to-hub`：実行しながら結果を hub に送ります。

**基準の ref は自分で渡してください。** ccqa は環境変数を一切読みません。
`pull_request` のワークフローなら `origin/$GITHUB_BASE_REF`、それ以外なら
比較したいものを指定します。解決できない ref はテストが 1 本も走る前に
usage error になります。空の差分として黙って通ることはありません。

**`actions/checkout` に `fetch-depth: 0` を指定してください。** shallow な
checkout には、その基準コミットが存在しません。

`--dry-run` を付けると選択結果を表示して止まります。選択そのものは、付けても
付けなくてもモデル呼び出し 1 回ぶんかかります。

### デプロイのたびに

2 段階に分かれ、それぞれ別のジョブになります。まずデプロイが成功した時点で、
何をデプロイしたかを hub に伝えます。

```bash
ccqa hub deploy record --profile ci --sha "$GITHUB_SHA" --select
```

続いて別のジョブで、そのデプロイによって信用できなくなった spec を実行します。

```bash
ccqa run --only-hub-stale --hub-profile ci --report-to-hub
```

- `--select`：デプロイした範囲がどの spec に到達するかを記録します。付けないと、
  そのエントリより後ろの spec は `notNeeded` ではなく `unknown` を返します。
- `--only-hub-stale`：各 spec が最後に実行されて以降にデプロイがその spec を
  触ったかどうかを、hub に問い合わせます。

hub は checkout を持たず `git` も実行しないので、デプロイが何を変えたかを自分では
割り出せません。判定を後から再構成せずデプロイと一緒に送るのはこのためで、
`--select` なしで記録したデプロイの穴は、あとから埋める手段がありません。

**導入直後は何も選ばれません。** 実行記録のない spec は `neverRun`、基準点が
デプロイログより古い spec は `unknown` になり、どちらも既定では実行されません。
デプロイを 1 件記録し、`--report-to-hub` を付けて全 spec を一度走らせれば、次の
デプロイから選択が意味を持ちます。このジョブは hub 上の spec 一覧も読むので、
`ccqa perspectives` を実行しておく必要があります。判定できなかった spec も
走らせたい場合は `--only-hub-stale-with-unknown` を付けます。

### 定期実行で

ブラウザもデプロイも使わずに、全 spec をコードと突き合わせます。

```bash
ccqa audit --report-format github --report-to-hub
```

- `--exit-on warn|error`（既定は `error`）：どの判定でジョブを失敗させるかを
  決めます。
- `--report-to-hub`：各判定を hub の spec ごとのドリフト台帳に記録します。
  台帳はテスト観点タブに表示され、`--only-hub-audited-clean` が読むのもこれです。
- `--only-affected-by <ref>`：`push` のワークフローで範囲を絞れます。モデル
  呼び出しが 1 回増えます。

マージ前のジョブは失敗した spec を既に監査しています。このジョブが見るのは残りで、
spec が通っていても、もう存在しないプロダクトを説明していることはあるからです。

台帳が溜まってきたら、デプロイ後の実行をそれに従わせられます。監査がシロと
言い、かつ前回の結果が古くなった spec にだけ実行を使う形です。

```bash
ccqa run --only-hub-audited-clean --only-hub-stale --hub-profile ci --report-to-hub
```

`--only-*` は前のフラグが残したものをさらに絞るので、重ねられます。

### ワークフロー

[CI integration](./running.md#ci-integration) に、マージ前の実行と定期監査の動く
ワークフローがあります。デプロイジョブについては
[`ccqa hub deploy record`](./hub.md#ccqa-hub-deploy-record) を参照してください。
Node の無いパイプライン向けに `curl` だけの例も載っています。

## ドキュメント

各詳細ドキュメントは英語版のみです。

| やりたいこと | ドキュメント |
|---|---|
| コマンドや環境変数を引く | [Command reference](./commands.md) |
| 仕様を書く（フィールド、再利用ブロック、ファイルアップロード、カバレッジ棚卸し） | [spec.yaml reference](./spec.md) |
| Claude と対話しながら仕様を書く | [Draft](./draft.md) |
| 既存のテスト資産を再利用する Playwright / runn テストを生成する | [Generation targets](./targets.md) |
| spec を実行してレポートを読む | [Running specs](./running.md) |
| 失敗を分類して判断を採点する | [Failure triage](./running.md#failure-triage) |
| 実行せずに spec とコードのずれを監査する | [Drift detection](./running.md#drift-detection) |
| 変更が到達する spec だけを再生する | [Scoping with `--only-affected-by`](./running.md#scoping-with---only-affected-by) |
| GitHub Actions に組み込む | [CI integration](./running.md#ci-integration) |
| live で spec を実行する（コード生成なし）、プロジェクト別のガイダンス | [Live specs](./live.md) |
| サインイン済みの状態で実行を始める、デバイス認証を避ける | [Saved sessions](./sessions.md) |
| 生成テストが使うアサーションを知る | [Assertions](./assertions.md) |
| 失敗した記録済みテストを自動修正する | [Auto-fix](./auto-fix.md) |
| 実行結果、セッション、変数をチームのサーバーに集約する | [Hub](./hub.md) |
| hub を HTTP で操作する | [Hub API](./hub-api.md) |
| なぜこの設計なのかを知る | [ADR](./adr/README.md) |

## ライセンス

MIT
