# 見積アプリ（mitsumori）— セットアップ手順

株式会社よつば建設工業 社内向け。現場の人が、現場で、見積を最初から最後まで作るアプリ。
仕様の正本は「見積アプリ_実装README_v2.md」。

このアプリは **静的サイト（HTML/CSS/JS のみ・ビルド不要）** です。
データは **Firebase Firestore**、スケッチ写真は **Firebase Storage** に保存します。

- 公開URL（予定）: https://nomurakougyouipad-oss.github.io/mitsumori/
- Firebase プロジェクト: mitsumori-35e9d（us-central1／Blaze）
- Googleアカウント: clover@yotsuba-official.com

---

## 初期セットアップ（Firebase コンソール）

### 1. プロジェクト作成
https://console.firebase.google.com/ で「プロジェクトを追加」→ 名前 `mitsumori`。
Google アナリティクスは**無効でよい**。

### 2. 料金プラン
プロジェクトの設定（⚙）→ 使用量と請求 → **Blaze（従量課金）** にアップグレード。
（姉妹アプリと同じ。通常利用なら無料枠内に収まる想定）

### 3. Firestore Database
構築 → Firestore Database → データベースを作成
- ロケーション: **us-central1**
- **本番環境モード**（全拒否）で開始
- 作成後、「ルール」タブに同梱の **`firestore.rules`** の中身を貼り付けて **公開**

### 4. Storage
構築 → Storage → 始める（ロケーションは Firestore と同じ）
- 「ルール」タブに同梱の **`storage.rules`** の中身を貼り付けて **公開**

### 5. 匿名認証
構築 → Authentication → 始める → ログイン方法 → **匿名** を有効化。

### 6. 承認済みドメイン
Authentication → Settings → 承認済みドメイン に
**`nomurakougyouipad-oss.github.io`** を追加。

### 7. ウェブアプリ登録
プロジェクトの概要 → ウェブ（`</>`）アイコン → アプリ名 `mitsumori`
（Hosting のチェックは**不要**。公開は GitHub Pages で行う）
表示された `firebaseConfig` の値を、同梱の **`firebase-config.js`** に貼り替える。

### 8. 接続テスト
`index.html`（接続テストページ）を開き、4項目すべて ✓ になることを確認。
- 公開後は https://nomurakougyouipad-oss.github.io/mitsumori/ で確認
- ローカル確認はサーバー経由で（file:// 直開きでは ES モジュールが動きません）

---

## GitHub Pages 公開

1. GitHub（nomurakougyouipad-oss）で公開リポジトリ `mitsumori` を作成
2. このフォルダを push
3. リポジトリの Settings → Pages → Branch: `main` / `(root)` → Save
4. 数分で https://nomurakougyouipad-oss.github.io/mitsumori/ に公開される

---

## セキュリティ設計について（正直な注意）

- 匿名認証＋ルールにより、未認証のアクセスや不正な形式のデータ書き込みは防げます。
- ただし匿名トークンは誰でも取得できるため、これ**だけ**では悪意ある第三者による
  書き込みを完全には防げません。社内・関係者限定の運用であれば実用十分です。
- より堅くするなら、本番稼働後に **Firebase App Check** の導入を推奨します。

## このリポジトリの構成（フェーズ0時点）

| ファイル | 内容 |
| --- | --- |
| index.html | 接続テストページ（フェーズ1でアプリ本体に置き換え） |
| firebase-config.js | Firebase接続設定（コンソールの値を貼る） |
| js/firebase.js | Firebase初期化（オフライン永続化＋匿名認証。zaiko-shohinから流用） |
| firestore.rules | Firestoreセキュリティルール（コンソールに貼る） |
| storage.rules | Storageセキュリティルール（コンソールに貼る） |
