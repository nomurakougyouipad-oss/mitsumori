// ============================================================
// データ層 — Firestoreの読み書きと検索インデックス
// ・設定(率・時間単価)・マスタ類はスナップショット購読でメモリに保持
// ・検索は正規化(ひらがな/カタカナ・全角半角・記号ゆれ)して部分一致
// ============================================================

import {
  db, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDoc, getDocs, onSnapshot, query, orderBy, serverTimestamp,
} from './firebase.js?v=21';
import { DEFAULT_RATES, DEFAULT_UNIT_RATES } from './calc.js?v=21';

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
// 「配管 25A」で SGP(溶協品) 25Ax5.5m が出るように、打った言葉を内部で置き換える。
// ※ 集計表の別名辞書（items.aliases）とは別物。
//    あちら＝品目単位（この行はこの品目）／こちら＝言葉単位（この言葉はこの表記）。
// この初期セットはコードに持つ（初回から設定なしで効く）。
// 追加・変更は Firestore の synonyms コレクションが上書きする（設定画面から編集）。
//
// 【この9件だけにしている理由】2026-08-01に実データ1,567件で確認して確定。
// ・入れたのは「そのまま打つと0件になる言葉」だけ
// ・配管には TP-A（小野建SUS・信栄のステンレス配管42件）も含める
// ・TPA … ハイフンを飛ばして打つと0件になるので TP-A に寄せる
// ・パイプは入れない … 今は角パイプ42件が正しく出る。SGPを足すと角パイプが
//   探しにくくなる。配管の方で拾う
// ・ボルト/ナット/ビス/ネジ/アンカー/寸切/角パイプ/丸棒/ｱﾝｸﾞﾙ/平鋼/チェッカーは
//   そのまま打てば出るので不要
// ・ステン→SUS304、鉄→SS400 は該当が659件・123件と多すぎて選べない。
//   材質は絞り込みで選ぶ
// ・C・L・FB のような1〜2文字への置き換えは誤ヒットするため入れない（下の guard 参照）
// ※ 半角の「ﾁｬﾝﾈﾙ」は norm() が全角に揃えるので「チャンネル」1件で両方に効く。
export const DEFAULT_SYNONYMS = [
  ['配管', ['SGP', 'STK', 'STPG', 'TP-A']],
  ['TPA', ['TP-A']],
  ['丸鋼', ['丸棒']],
  ['山形鋼', ['ｱﾝｸﾞﾙ']],
  ['フラットバー', ['平鋼']],
  ['縞鋼板', ['縞板']],
  ['チャンネル', ['溝形鋼']],
  ['H鋼', ['H形鋼']],
  ['エッチ', ['H形鋼']],
];

// 1〜2文字の英数字（C・L・FB等）への置き換えは、無関係な品目まで拾うので禁止。
// 設定画面でも保存前に弾く（この判定を共用する）。
export const isTooShortTerm = (t) => /^[0-9a-z]{1,2}$/i.test(norm(t));

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

// 1〜2文字の英字への置き換えは禁止（設定画面で弾く）が、古い端末が書いた
// データが残っていても暴発しないよう、当てる位置を絞る保険を残しておく。
//  ・2文字: 前後が英字でなければ当てる
//  ・1文字: 寸法の頭に付く形（L-6x65・C-125x65）だけに当てる
// これがないと L が AL6063・PL型切 に、C が S45C( や FB-C) に当たってしまう。
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
  // トークン同士はAND（「配管 25A」は両方必要）、展開した候補同士はOR
  // （「配管」は SGP でも STK でも STPG でもよい）。
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

// 見積を明細ごと削除する（元に戻せないので、呼ぶ側で必ず確認をとること）
export async function deleteEstimateDeep(estimateId) {
  const snap = await getDocs(collection(db, 'estimates', estimateId, 'lines'));
  for (const d of snap.docs) await deleteDoc(d.ref);
  await deleteDoc(doc(db, 'estimates', estimateId));
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
