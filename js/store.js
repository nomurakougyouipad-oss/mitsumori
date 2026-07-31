// ============================================================
// データ層 — Firestoreの読み書きと検索インデックス
// ・設定(率・時間単価)・マスタ類はスナップショット購読でメモリに保持
// ・検索は正規化(ひらがな/カタカナ・全角半角・記号ゆれ)して部分一致
// ============================================================

import {
  db, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDoc, onSnapshot, query, orderBy, serverTimestamp,
} from './firebase.js?v=5';
import { DEFAULT_RATES, DEFAULT_UNIT_RATES } from './calc.js?v=5';

// ---------- 検索の正規化 ----------
// ひらがな→カタカナ、全角→半角(NFKC)、大文字→小文字、記号ゆれ(×→x等)を吸収
export function norm(s) {
  if (s == null) return '';
  let t = String(s).normalize('NFKC').toLowerCase();
  t = t.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)); // ひら→カタ
  t = t.replace(/[×✕╳]/g, 'x').replace(/[⌀ø]/g, 'φ').replace(/[‐－―ー−]/g, '-');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// ---------- メモリキャッシュ ----------
export const cache = {
  rates: { ...DEFAULT_RATES },
  unitRates: { ...DEFAULT_UNIT_RATES, trades: [] }, // trades: [{name, rate}]
  items: [],          // 単価マスター（searchKey付き）
  itemsLoaded: false,
  staff: [],
  customers: [],
  suppliers: [],
  standingOrders: [],
  estimates: [],      // 見積一覧（更新が新しい順）
};

const listeners = new Set();
export function onCacheChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach((fn) => fn()); }

// ---------- 購読の開始（起動時に1回呼ぶ） ----------
export function startSubscriptions() {
  onSnapshot(doc(db, 'settings', 'rates'), (snap) => {
    if (snap.exists()) cache.rates = { ...DEFAULT_RATES, ...snap.data() };
    emit();
  }, (e) => console.error('rates購読失敗:', e));

  onSnapshot(doc(db, 'settings', 'unitRates'), (snap) => {
    if (snap.exists()) cache.unitRates = { ...DEFAULT_UNIT_RATES, trades: [], ...snap.data() };
    emit();
  }, (e) => console.error('unitRates購読失敗:', e));

  const simple = [
    ['staff', 'staff'], ['customers', 'customers'],
    ['suppliers', 'suppliers'], ['standingOrders', 'standingOrders'],
  ];
  for (const [col, key] of simple) {
    onSnapshot(query(collection(db, col), orderBy('name')), (snap) => {
      cache[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      emit();
    }, (e) => console.error(col + '購読失敗:', e));
  }

  onSnapshot(query(collection(db, 'estimates'), orderBy('updatedAt', 'desc')), (snap) => {
    cache.estimates = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    emit();
  }, (e) => console.error('estimates購読失敗:', e));

  onSnapshot(collection(db, 'items'), (snap) => {
    cache.items = snap.docs.map((d) => {
      const it = { id: d.id, ...d.data() };
      it.searchKey = norm([it.name, it.category, it.material, it.spec, it.supplier].join(' '));
      return it;
    });
    cache.itemsLoaded = true;
    emit();
  }, (e) => console.error('items購読失敗:', e));
}

// ---------- 品目検索 ----------
// 「アングル 65」→ 全トークンを含む品目。よく使う順→更新日新しい順
export function searchItems(q, max = 30) {
  const tokens = norm(q).split(' ').filter(Boolean);
  if (!tokens.length) {
    // 空検索: よく使う順に上位を出す
    return [...cache.items]
      .sort((a, b) => (b.useCount || 0) - (a.useCount || 0))
      .slice(0, max);
  }
  const hits = [];
  for (const it of cache.items) {
    if (tokens.every((t) => it.searchKey.includes(t))) hits.push(it);
  }
  hits.sort((a, b) =>
    (b.useCount || 0) - (a.useCount || 0) ||
    tsMillis(b.updatedAt) - tsMillis(a.updatedAt));
  return hits.slice(0, max);
}

function tsMillis(v) { return v && v.toMillis ? v.toMillis() : 0; }

// 更新日が半年以上前（または不明）の品目に色をつける判定
export function isStale(item) {
  const ms = tsMillis(item.updatedAt);
  if (!ms) return true;
  return Date.now() - ms > 183 * 24 * 3600 * 1000;
}

export async function bumpUseCount(itemId) {
  try {
    await updateDoc(doc(db, 'items', itemId), { useCount: (cache.items.find((i) => i.id === itemId)?.useCount || 0) + 1 });
  } catch (e) { console.warn('useCount更新失敗:', e); }
}

// ---------- 見積 ----------
export async function createEstimate(staffName) {
  const ref = await addDoc(collection(db, 'estimates'), {
    projectName: '', site: '', customer: '', orderNo: '',
    staff: staffName || '', status: '見積中',
    welfareOn: true, ratesEdited: false,
    rates: { ...cache.rates },
    unitRates: { travelLabor: cache.unitRates.travelLabor, kmRate: cache.unitRates.kmRate },
    adjust: 0, sketchPhotos: [],
    linesCount: 0, pendingCount: 0, totalFinal: 0,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export function subscribeEstimate(id, cb) {
  return onSnapshot(doc(db, 'estimates', id), (snap) => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null));
}

export function subscribeLines(estimateId, cb) {
  return onSnapshot(query(collection(db, 'estimates', estimateId, 'lines'), orderBy('order')), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function updateEstimate(id, patch) {
  await updateDoc(doc(db, 'estimates', id), { ...patch, updatedAt: serverTimestamp() });
}

export async function addLine(estimateId, line) {
  const ref = await addDoc(collection(db, 'estimates', estimateId, 'lines'), line);
  return ref.id;
}

export async function updateLine(estimateId, lineId, patch) {
  await updateDoc(doc(db, 'estimates', estimateId, 'lines', lineId), patch);
}

export async function deleteLine(estimateId, lineId) {
  await deleteDoc(doc(db, 'estimates', estimateId, 'lines', lineId));
}

// 集計後のサマリーを見積ドキュメントに写す（ホーム一覧が明細を読まずに済むように）
export async function saveSummary(estimateId, t, lines) {
  await updateDoc(doc(db, 'estimates', estimateId), {
    linesCount: lines.length,
    pendingCount: lines.filter((l) => l.pendingPrice).length,
    totalFinal: Math.round(t.final),
    updatedAt: serverTimestamp(),
  });
}

// 見積一覧（自分の工事／会社全体）
export function subscribeEstimates(cb) {
  return onSnapshot(query(collection(db, 'estimates'), orderBy('updatedAt', 'desc')), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

// ---------- 汎用マスタ追加 ----------
export async function addNamed(col, data) {
  const ref = await addDoc(collection(db, col), data);
  return ref.id;
}
