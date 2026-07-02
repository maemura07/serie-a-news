# SERIE A OGGI — セリエA現地ニュース 日本語自動要約ページ

セリエA全クラブの現地報道を、2時間ごとに自動収集して自然な日本語2〜3文に翻訳要約し、公開ページに掲載する仕組みです。

- ロボット（収集・要約）: **GitHub Actions**（無料）
- ページ公開: **GitHub Pages**（無料）
- 要約AI: **Anthropic API**（従量課金・月数百円程度の想定）

---

## 初期セットアップ（1回だけ・所要20分くらい）

### ① Anthropic APIキーを取得する
1. https://console.anthropic.com にアクセスしてアカウント作成（Claude.aiのアカウントとは別物です）
2. 支払い方法（クレカ）を登録し、少額（$5など）をチャージ
3. 「API Keys」→「Create Key」でキーを発行し、`sk-ant-...` で始まる文字列をコピーして控えておく
   ※このキーは**絶対にリポジトリのファイル内に書かない**こと。次の手順③の「Secrets」にだけ入れます。

### ② GitHubにリポジトリを作る
1. https://github.com でアカウント作成（未取得の場合）
2. 右上「＋」→「New repository」
3. Repository name: `serie-a-news`（何でもOK）／ **Public** を選択 ／「Create repository」
4. このフォルダの中身を全部アップロードする
   - 画面の「uploading an existing file」リンクから、フォルダの中身をドラッグ＆ドロップ
   - **注意**: `.github` フォルダ（先頭にドットが付く隠しフォルダ）はドラッグ＆ドロップで漏れがちです。漏れた場合は、リポジトリ画面で「Add file → Create new file」を押し、ファイル名欄に `.github/workflows/update.yml` と入力して、このフォルダ内の同名ファイルの中身をコピペで貼り付けてください。

### ③ APIキーを金庫（Secrets）に登録する
1. リポジトリ画面の「Settings」→ 左メニュー「Secrets and variables」→「Actions」
2. 「New repository secret」
3. Name: `ANTHROPIC_API_KEY` ／ Secret: ①でコピーしたキー → 「Add secret」

### ④ ページ公開をONにする
1. 「Settings」→ 左メニュー「Pages」
2. Source: 「Deploy from a branch」／ Branch: `main`・フォルダ `/ (root)` → 「Save」
3. 数分後、`https://（ユーザー名）.github.io/serie-a-news/` がページのURLになります

### ⑤ 初回実行してみる
1. リポジトリ画面の「Actions」タブ →（初回は「I understand... enable them」的なボタンが出たら押す）
2. 左の「ニュース自動更新」→ 右の「Run workflow」→ 緑のボタン
3. 1〜2分で完了。緑のチェックが付けばOK。ページを開くと記事が並んでいるはずです
4. 以降は**2時間ごとに全自動**で更新されます（GitHub側の混雑で多少遅れることがあります）

---

## 日々の運用

### ソース（巡回先）の追加・削除・オンオフ
リポジトリ画面で `sources.json` を開き、鉛筆アイコン（Edit）で編集 → 「Commit changes」。コードは触らなくてOK。

- 停止したいソースは `"enabled": false` にする
- 追加する場合はこの形式で1ブロック足す:
  ```json
  {
    "name": "媒体名",
    "url": "RSSフィードのURL",
    "tag": "milan",
    "enabled": true
  }
  ```
- `tag` は milan / inter / juventus / roma / lazio / atalanta / fiorentina / altro のどれか。横断的な媒体は `altro` にしておけば、AIが記事ごとにクラブを判定します

### フィードが取れているかの確認
「Actions」タブ → 最新の実行 → 「記事収集・要約」のログに、ソースごとの成否（OK / SKIP）が出ます。SKIPが続くソースはRSSのURLが変わった可能性が高いので、`sources.json` のURLを差し替えてください。
※ Gazzetta / Corriere dello Sport / ANSA のフィードURLは初期値として入れていますが、媒体側の都合で変わることがあります。Google News経由の7クラブ分フィードは安定して動くはずなので、最悪それだけでも全クラブをカバーできます。

### お金まわり
- GitHub: 無料（Publicリポジトリ）
- Anthropic API: 使った分だけ。1回の実行で最大40記事×軽量モデルなので、フル稼働でも月数百円程度の見込み。console.anthropic.com の「Usage」で確認でき、上限額（Spending limit）も設定できます。**最初に上限を $10/月 などに設定しておくのがおすすめ**

---

## よくあるトラブル

| 症状 | 対処 |
|---|---|
| Actionsが赤く失敗する | ログを開いて確認。「ANTHROPIC_API_KEY が設定されていません」なら手順③をやり直し |
| ページが「記事がまだありません」のまま | 初回のActionsを手動実行したか確認（手順⑤）。実行済みならログでフィードが全SKIPになっていないか確認 |
| 2ヶ月放置したら更新が止まった | GitHubの仕様（60日無操作で自動停止）。「Actions」タブに出る「Enable workflow」ボタンを押せば再開。※通常は毎回の自動コミットで防止されるので、起きるのはフィードが全滅して更新ゼロが60日続いた場合のみ |
| 記事のURLを変えたい・独自ドメインにしたい | Settings → Pages でカスタムドメイン設定、またはXserverへの移行（相談してください） |

---

## ファイル構成

```
serie-a-news/
├── index.html                    … 公開ページ本体
├── sources.json                  … 巡回先の設定（ここだけ触ればOK）
├── data/articles.json            … 収集済み記事データ（自動生成・触らない）
├── scripts/update.js             … 収集・要約プログラム
├── package.json                  … プログラムの依存定義
└── .github/workflows/update.yml  … 2時間ごとの自動実行設定
```

更新間隔を変えたい場合は `.github/workflows/update.yml` の `cron: "0 */2 * * *"` を編集（`*/3` で3時間ごと、など）。
