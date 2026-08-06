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

---

## 開発用ツール（tools/）

ブラウザで開くと、その場の単価マスターを読んで結果を出す。書き換えはしない。
公開URLからも開ける（例 https://nomurakougyouipad-oss.github.io/mitsumori/tools/audit-naming.html ）。

| ファイル | 内容 |
| --- | --- |
| audit-naming.html | 単価マスターの表記ゆれの洗い出し。種類×材質で型の多数派を出し、外れているものを分類して「直す／要確認／別物」を判定 |
| audit-noname.html | 品名に種類（ｴﾙﾎﾞ・ｿｹｯﾄ等）が入っていない行の判断材料。仕入先・原価・重量・kg単価・更新日・大分類・種類(K列)・同寸法の他の行を並べる |
| test-catalog.html | 規格カタログの組み立て結果（種類×材質ごとの型・形の数・長さ） |
| test-catalog-parity.html | 検索から選んだ場合と規格から選んだ場合で、同じ品名・同じitemIdになるかの突き合わせ |
| test-tally-match.html | 集計表の自動判定の検証。`?noprev=1` で旧品名(prevNames)を無効にして比べられる |
| test-material-ui.html | 材料を追加する画面の単体確認（iPhoneの入力不具合の再現用） |
| test-calc.html | 金額計算の検証 |
| gen-jis-sizes.ps1 / jis-sizes.source.json | JIS標準サイズ表と、そこから js/jis-sizes.js を生成するスクリプト |

**単価マスターの表記ルールは `見積アプリ_実装README_v2.md` の第4章「単価マスターの表記ルール」を参照。**
配管はスケジュールではなく肉厚mmで表す、旧品名は `items.prevNames` に残す、など。
