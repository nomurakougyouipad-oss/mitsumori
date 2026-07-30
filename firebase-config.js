// Firebase設定 — 見積アプリ (mitsumori)
// ※ この設定値は「住所」のようなもので秘密の鍵ではありません。
//    データの守りはFirestore/Storageのセキュリティルールで行います。
//
// 【セットアップ】Firebaseコンソールでウェブアプリを登録すると
// この形の firebaseConfig が表示されます。値をそのまま貼り替えてください。

const firebaseConfig = {
  apiKey: "（ここに貼り替え）",
  authDomain: "（ここに貼り替え）",
  projectId: "（ここに貼り替え）",
  storageBucket: "（ここに貼り替え）",
  messagingSenderId: "（ここに貼り替え）",
  appId: "（ここに貼り替え）"
};

export default firebaseConfig;
