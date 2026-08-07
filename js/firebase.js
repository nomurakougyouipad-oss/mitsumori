// ============================================================
// Firebase 初期化 — Firestore / Storage / 匿名認証
// 姉妹アプリ（zaiko-shohin）から流用。
// 静的サイト（GitHub Pages）から CDN の Firebase v10 モジュールを利用
// ・Firestore はオフライン永続化を有効化（複数タブ対応）
//   → 電波が切れても見積の下書きは端末に保持され、復帰時に自動送信される
//   → 自前の送信キューは作らない（README v2 第1章）
// ============================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDocs, getDoc, onSnapshot, query, where, orderBy, limit,
  serverTimestamp, writeBatch, increment, Timestamp, arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject, listAll,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  getFunctions, httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js';
import {
  initializeAppCheck, ReCaptchaEnterpriseProvider,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app-check.js';

import firebaseConfig from '../firebase-config.js?v=33';

export const app = initializeApp(firebaseConfig);

// ---------- App Check ----------
// 受付（AI）の入口は、インターネットの誰からでも届く場所に置かざるを得ない。
// 匿名ログインだけでは、apiKey を見た誰でも通れてしまい、AIの料金を焼かれる。
// App Check は「本当にこのアプリから来たか」を確かめる関門。
//
// 【このサイトキーは秘密ではない】ブラウザで誰でも読める公開値。
//   秘密の鍵は Google 側にあり、こちらには無い（APIキーと同じ扱いにしないこと）。
// 【効かせている先は受付だけ】
//   Firestore と Storage には強制していない。強制すると、電波の悪い現場で
//   下書きの保存まで巻き添えで止まる。芯2（止めない）に反する。
// 【ドメイン】nomurakougyouipad-oss.github.io で登録済み。
//   別のドメインで開くと通らない。localhost で試すときはデバッグトークンが要る。
try {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider('6LdPZ3ktAAAAAGZsfuVzHpyp6hpsU2L-WOAo0mF3'),
    isTokenAutoRefreshEnabled: true,
  });
} catch (e) {
  // ここで落としてはいけない。App Check が張れなくてもアプリ本体は動かす。
  // 通らないのは受付（AI）だけで、そのときは画面がひな形に戻す。
  console.warn('App Check を初期化できませんでした（AIだけ使えません）:', e);
}

// オフライン永続化（IndexedDB）。プライベートブラウズ等で失敗しても
// アプリ自体は動かしたいので、失敗時は通常キャッシュで初期化し直す。
let _db;
let _persistenceEnabled = true;
try {
  _db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} catch (e) {
  console.warn('オフライン永続化を有効にできませんでした（メモリキャッシュで継続）:', e);
  _db = initializeFirestore(app, {});
  _persistenceEnabled = false;
}
export const db = _db;
export const persistenceEnabled = _persistenceEnabled;

export const storage = getStorage(app);
export const auth = getAuth(app);

// 受付（Functions）。APIキーは向こう側（Secret Manager）にあり、こちらには無い。
// リージョンは functions/index.js の region と必ず同じにすること。
// 違うと「見つかりません」になる（よくある詰まりどころ）。
export const functions = getFunctions(app, 'asia-northeast1');

// 匿名サインイン。ready が解決したらデータ操作可能。
export const ready = new Promise((resolve, reject) => {
  onAuthStateChanged(auth, (user) => {
    if (user) resolve(user);
  });
  signInAnonymously(auth).catch((err) => {
    console.error('匿名サインインに失敗:', err);
    reject(err);
  });
});

// Firestore/Storage の関数を再エクスポート（他モジュールで使用）
export {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDocs, getDoc, onSnapshot, query, where, orderBy, limit,
  serverTimestamp, writeBatch, increment, Timestamp, arrayUnion, arrayRemove,
  storageRef, uploadBytes, getDownloadURL, deleteObject, listAll,
  httpsCallable,
};
