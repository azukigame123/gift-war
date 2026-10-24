# ギフト攻城戦（サーバー）

TikTok LIVE のギフト・いいね・コメントで兵を出して戦う、2人対戦ゲームのサーバーです。
このサーバー1つで、ゲーム画面の配信、部屋（入室コード）、試合の計算、TikTok接続をすべて行います。

## 動かし方（Render）
1. このリポジトリを Render の「New → Blueprint」で選ぶ（render.yaml を読みます）
2. 環境変数 `EULER_API_KEY` に Euler Stream の APIキーを入れる
3. できたURL（例 https://gift-war.onrender.com/ ）を開くとゲーム画面が出ます

## ローカルで試す
```
npm install
MOCK_TIKTOK=1 node server.js   # TikTokの代わりに疑似のギフトが届く
```
http://localhost:8080/ を2つのブラウザで開いて対戦できます。

## 環境変数
| 名前 | 内容 |
|---|---|
| EULER_API_KEY | Euler Stream のAPIキー（TikTok接続用） |
| PORT | 待ち受けポート（Renderが自動で入れます） |
| MOCK_TIKTOK | 1 にすると疑似のTikTok接続（テスト用） |
| ALLOW_OFFLINE | 1 にすると配信していなくても対戦を始められる（テスト用） |

## ファイル
| ファイル | 役割 |
|---|---|
| server.js | HTTP・WebSocket・部屋・試合の進行 |
| sim.js | public/index.html の計算部分（//#SIM-A〜//#END-B）を取り出してサーバーで動かす |
| tiktok.js | TikTok LIVE 接続（ユーザー名ごとに1本、部屋どうしで共有） |
| public/index.html | ゲーム画面（ブラウザ） |
