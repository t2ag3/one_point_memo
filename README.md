# 一口メモ道場：Cloudflare 版

Cloudflare Pages に置いて公開する版です。

- **4 択（初級〜上級）**：画面に埋め込んだ問題バンクから出します。AI は使いません。
- **地獄級**：Pages Functions（`functions/api/hell/`）が、OpenRouter 経由で AI を呼びます。
- **音声入力**：ブラウザの音声認識（Edge・Chrome）を使います。サーバーに音声は送りません。
- **状態**：サーバーはデータベースを持ちません。対話の状態は、署名付きのトークンとしてブラウザに持たせます。

## 置くもの（SageMaker の作業環境で作る）

```
cd ~/work/hitokuchi_dojo
python3 tools/build_cloudflare.py          # public/・lib/data.js・lib/fixtures.json を作り直す
```

できた `cloudflare` フォルダを、ネットにつながる PC に持っていきます。`dist/hitokuchi_dojo_cloudflare.zip` に同じものが入っています。
- `public/`：画面と PDF とスライド画像（約 100MB）です。スライド画像を省くときは `--no-images` を付けます。
- 問題バンクを作り直したら、このコマンドを動かし直してから、デプロイし直します。

## 1. OpenRouter の準備
1. OpenRouter でアカウントと API キーを作ります。
2. キーの設定で、利用の上限（クレジットの上限）を決めておきます。使いすぎを防ぐ最後の歯止めになります。
3. 無料のモデル（`:free`）を使う場合
   - プライバシーの設定で、無料のモデルの利用（送った内容が記録・学習に使われうるもの）を許可する必要があることがあります。
   - 無料のモデルには、1 分あたり・1 日あたりの回数の上限があります（クレジットを入れているかで変わります）。上限に当たると、画面に「混み合っています」と出ます。
4. モデル ID（既定は `nvidia/nemotron-3-ultra-550b-a55b:free`）が今も使えるか、OpenRouter のモデルの一覧で確かめます。

## 2. 本物の AI でためす（デプロイの前に）
`cloudflare` フォルダで、次のコマンドを動かします（Node.js 20 以上）。

```
OPENROUTER_API_KEY=sk-or-… node scripts/smoke.mjs
```

PowerShell なら `$env:OPENROUTER_API_KEY="sk-or-…"; node scripts/smoke.mjs` です。

- 1 人分の相談 → 追加の質問 → 採点が流れ、時間と中身が出ます。
- 「答えの形が正しくありませんでした」が続くときの直し方
  - `JSON_SCHEMA=0` を足して試します（JSON の形の指定に対応していないモデル向け）。
  - または、`MODEL_CONSULT`・`MODEL_GRADE` を別のモデルに変えます。
- 相談の日本語や採点の質が物足りないときは、採点だけでも強いモデルに変えると改善しやすいです。

## 3. Cloudflare に置く
`cloudflare` フォルダで、次を順に動かします。

```
npx wrangler login
npx wrangler pages project create hitokuchi-dojo --production-branch main
npx wrangler pages secret put OPENROUTER_API_KEY --project-name hitokuchi-dojo
npx wrangler pages secret put SESSION_SECRET --project-name hitokuchi-dojo
npx wrangler pages deploy --project-name hitokuchi-dojo
```

- `SESSION_SECRET` には、ランダムな長い文字列（32 文字以上）を入れます。作るときは `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` を使います。
  - この値を変えると、遊んでいる途中の挑戦は無効になります。
- deploy は、`wrangler.toml` の `pages_build_output_dir`（public）と `functions/` を読みます。
- wrangler がプロジェクトの名前の設定を求めてきたら、`wrangler.toml` の先頭に、`name` キーで `"hitokuchi-dojo"` を指定する行を足してください。
- 置いたあとは `https://hitokuchi-dojo.pages.dev/` などで開けます。

## 4. 守りを足す（公開するなら強くすすめる）
### 1 日の回数制限（D1）
1. D1 のデータベースと表を作ります。

   ```
   npx wrangler d1 create hitokuchi-dojo
   npx wrangler d1 execute hitokuchi-dojo --remote --file=schema.sql
   ```

2. `wrangler.toml` に `[[d1_databases]]` の段を足します。中身は次の 3 つです。
   - `binding` は `"DB"`
   - データベースの名前（database_name のキー）は `"hitokuchi-dojo"`
   - `database_id` は、`d1 create` で出た ID
3. もう一度 deploy します。

- 既定の上限は、接続元ごとに 1 日 60 回、全体で 1 日 2,000 回です。AI を 1 回呼ぶごとに 1 回と数えます。1 回の挑戦（相談者 3 人）は、およそ 9 回になります。
  - 上限は `wrangler.toml` の `DAILY_LIMIT_PER_IP`・`DAILY_LIMIT_TOTAL` で変えられます。
- 接続元の IP は、そのまま保存しません。`SESSION_SECRET` を混ぜたハッシュにして保存します。

### Turnstile（ロボット対策）
1. Cloudflare のダッシュボードの Turnstile で、サイト（例：hitokuchi-dojo.pages.dev）を足し、サイトキーと秘密のキーを受け取ります。
2. SageMaker の作業環境で `python3 tools/build_cloudflare.py --turnstile-site-key （サイトキー）` を動かして、画面を作り直します。
3. `npx wrangler pages secret put TURNSTILE_SECRET --project-name hitokuchi-dojo` で、秘密のキーを入れます。
4. もう一度 deploy します。

地獄級を始めるときに、ロボット対策の確認が出ます。

## 設定（wrangler.toml の vars）
| 名前 | 意味 | 既定 |
|---|---|---|
| `MODEL_CONSULT` / `MODEL_GRADE` | 相談者・採点の AI（OpenRouter のモデル ID） | `nvidia/nemotron-3-ultra-550b-a55b:free` |
| `MODEL_FALLBACKS` | 予備のモデル（カンマ区切り。最初のモデルが使えないとき順に試す） | なし |
| `JSON_SCHEMA` | `"0"` で JSON の形の指定を送らない | 送る |
| `REASONING_CONSULT` / `REASONING_GRADE` | 考える深さ（low・medium・high。対応しているモデルだけ） | 送らない |
| `MAX_TOKENS` | 答えの長さの上限 | 4000 |
| `DAILY_LIMIT_PER_IP` / `DAILY_LIMIT_TOTAL` | 1 日の回数の上限（D1 があるときだけ） | 60 / 2000 |

秘密の値（`wrangler pages secret put` で入れる）は次のとおりです。
- `OPENROUTER_API_KEY`（必須）
- `SESSION_SECRET`（必須、16 文字以上）
- `TURNSTILE_SECRET`（Turnstile を使うときだけ）

## 費用の目安
- **Cloudflare**：Pages・Functions・D1・Turnstile は、無料枠でほぼ 0 円です。
  - Functions は Workers の無料枠に数えられます（1 日 10 万回）。
  - 超えるときは、Workers の有料プラン（月 5 ドル）にします。
- **AI**
  - 無料のモデルなら 0 円です。ただし回数の上限があり、混むと待たされたり使えなかったりします。
  - 有料のモデルに切り替えたときの目安（1 回の挑戦＝相談者 3 人）は次のとおりです。
    - Claude Haiku 5.5 だけ：約 1 円
    - 相談者は Haiku 5.5、採点は Sonnet 5.5：約 15 円
    - Opus 5.5：約 45 円
  - 金額は Anthropic の公表価格をもとに、1 ドル 150 円で計算しています。OpenRouter での値段は同じモデルならほぼ同じで、クレジットを入れるときに数％の手数料がかかります。
- 料金は変わることがあります。各社の料金のページで確かめてください。

## 注意
- 回答は AI の提供元に送られます。画面にも、その旨と「個人の情報は書かない」ことを出しています。
- 点数は AI による目安です。点数はサーバーで計算しています。AI に付けてもらうのは、ラベル（正しい・誤り、言えた・抜け、0〜3 の評価）だけです。
- OpenRouter の API の細かいところ（`models`・`response_format`・`reasoning` の扱い）は、作った時点の知識に基づいています。`scripts/smoke.mjs` で確かめてください。
- 4 択の問題・採点の決まり・指示文は、サーバー版（`~/work/hitokuchi_dojo`）と同じです。
  - 指示文を変えるときは、`prompts.py` と `lib/prompts.js` の両方を直します。
  - そのあと `python3 tools/build_cloudflare.py` → `node --test test/` で、同じになっているかを確かめます。

## テスト（ネットにつながらなくても動く）
```
cd cloudflare && node --test test/      # 偽物の OpenRouter・D1・Turnstile で、API の流れを確かめる
cd .. && node tests/test_dom.js         # 画面の操作（Cloudflare 版の地獄級・音声認識も）
```
