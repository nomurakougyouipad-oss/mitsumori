// ============================================================
// データ層 — Firestoreの読み書きと検索インデックス
// ・設定(率・時間単価)・マスタ類はスナップショット購読でメモリに保持
// ・検索は正規化(ひらがな/カタカナ・全角半角・記号ゆれ)して部分一致
// ============================================================

import {
  db, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDoc, onSnapshot, query, orderBy, serverTimestamp,
} from './firebase.js?v=9';
import { DEFAULT_RATES, DEFAULT_UNIT_RATES } from './calc.js?v=9';

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

// ---------- 検索の言い換え辞書（同義語） ----------
// 現場は社内マスターの表記（SGP・ｱﾝｸﾞﾙ等）ではなく普段の言葉で打つ。
// 「パイプ 25A」で SGP(溶協品) 25Ax5.5m が出るように、打った言葉を内部で置き換える。
// ※ 集計表の別名辞書（items.aliases）とは別物。
//    あちら＝品目単位（この行はこの品目）／こちら＝言葉単位（この言葉はこの表記）。
// この初期セットはコードに持つ（初回から設定なしで効く）。
// 追加・変更は Firestore の synonyms コレクションが上書きする（設定画面から編集）。
export const DEFAULT_SYNONYMS = [
  ['パイプ', ['SGP', 'STK', 'STPG', '丸ﾊﾟｲﾌﾟ']],
  ['配管', ['SGP', 'STK', 'STPG', '丸ﾊﾟｲﾌﾟ']],
  ['丸鋼', ['RB', '丸棒']],
  ['丸棒', ['RB', '丸棒']],
  ['山形鋼', ['ｱﾝｸﾞﾙ', 'L']],
  ['溝形鋼', ['C']],
  ['チャンネル', ['C']],
  ['平鋼', ['FB']],
  ['フラットバー', ['FB']],
  ['縞鋼板', ['縞板']],
  ['ステン', ['SUS304', 'SUS316']],
  ['ステンレス', ['SUS304', 'SUS316']],
  ['鉄', ['SS400']],
  ['ボルト', ['BT', '六角ﾎﾞﾙﾄ']],
  ['ナット', ['NT']],
  ['ワッシャー', ['FW', 'SW', 'PW']],
];

// 「SGP、STK」「SGP STK」「SGP/STK」どれでも区切れるようにする
export const splitTerms = (s) => String(s || '').split(/[、,，／/｜|\s]+/).map((x) => x.trim()).filter(Boolean);

// 初期セット＋Firestoreの追加/上書き を合わせた辞書を作る
// （同じ言葉がFirestoreにあればそちらが勝つ。中身を空にすると初期セットを無効化できる）
export function synonymMap() {
  const m = new Map();
  const put = (word, terms) => {
    const w = norm(word);
    if (!w) return;
    const list = terms.map(norm).filter(Boolean);
    if (list.length) m.set(w, list); else m.delete(w);
  };
  for (const [w, t] of DEFAULT_SYNONYMS) put(w, t);
  for (const s of cache.synonyms) put(s.name, splitTerms(s.terms));
  return m;
}

// 1〜2文字の英字（L・C・BT等）は、そのまま部分一致させると無関係な品目まで拾うので
// 当てる位置を絞る。前に英字が地続きなら別物（AL6063・PL型切 の l など）。
//  ・2文字（BT・NT・FW・SW）: 後ろも英字でなければ当てる
//    （「根角BT(ｷｼﾞ)」「(B,N,SW,2FW)」に当てたいので、数字や記号の隣は許す）
//  ・1文字（L・C）: 寸法の頭に付く形（L-6x65・C-125x65）だけに当てる。
//    これをしないと S45C( や FB-C) まで拾ってしまう
function termHit(key, term) {
  if (!/^[a-z]{1,2}$/.test(term)) return key.includes(term);
  const single = term.length === 1;
  let i = key.indexOf(term);
  while (i !== -1) {
    const before = i > 0 ? key[i - 1] : ' ';
    const after = i + term.length < key.length ? key[i + term.length] : ' ';
    const okBefore = !/[a-z]/.test(before);
    const okAfter = single ? /[-0-9]/.test(after) : !/[a-z]/.test(after);
    if (okBefore && okAfter) return true;
    i = key.indexOf(term, i + 1);
  }
  return false;
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
  synonyms: [],       // 検索の言い換え（追加・上書き分）
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
    ['synonyms', 'synonyms'],
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
  // 打った言葉を言い換え辞書で展開する。
  // トークン同士はAND（「パイプ 25A」は両方必要）、展開した候補同士はOR
  // （「パイプ」は SGP でも STK でも 丸ﾊﾟｲﾌﾟ でもよい）。
  const syn = synonymMap();
  const groups = tokens.map((t) => {
    const alts = syn.get(t);
    return alts ? [t, ...alts] : [t];
  });
  const hits = [];
  for (const it of cache.items) {
    if (groups.every((g) => g.some((t) => termHit(it.searchKey, t)))) hits.push(it);
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
