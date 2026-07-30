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
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';

import firebaseConfig from '../firebase-config.js?v=2';

export const app = initializeApp(firebaseConfig);

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
  storageRef, uploadBytes, getDownloadURL, deleteObject,
};
