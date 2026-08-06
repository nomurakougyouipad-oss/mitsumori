// ============================================================
// 概算見積のデータ層 — Firestore の読み書き
//
// 【この段階でやること】保存だけ。AI呼び出し（Functions）はまだ入れない。
//   CLAUDE.md「3と4が未了のうちは、Functions と AI 呼び出しを実装しない」
//   使いはじめた日から記録が残らないと、半年後に実績が0件になる。だから保存が先。
//
// 【上書きしない】概算・本見積・実績はそれぞれ別に残す。
//   概算は roughEstimates、本見積は estimates。概算から本見積を作っても概算は消えない。
//
// 【保存したら金額は動かない】保存のときに率と単価を焼き付ける（freezeRough）。
//   あとで設定を変えても、出した見積の金額は変わらない。
//
//   roughEstimates/{id}
//     /items/{itemId}      読み取った項目（手順は steps 配列で持つ）
//     /questions/{qid}     ききたいこと
//     /sketches/{sid}      スケッチしてもらう
//     /chat/{msgId}        見積の中のやりとり（学習には回さない。覚えることは rough-memory.js）
// ============================================================

import {
  db, storage, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDoc, getDocs, onSnapshot, query, orderBy, serverTimestamp,
  storageRef, uploadBytes, getDownloadURL, deleteObject,
} from './firebase.js?v=33';
import { cache } from './store.js?v=33';
import { recordRateChange, tradeKey } from './rate-history.js?v=33';
import { DEFAULT_RATES, DEFAULT_UNIT_RATES } from './calc.js?v=33';
import {
  DEFAULT_ROUGH_OPTIONS, WORK_TYPES, ITEM_KINDS,
  resolveRates, resolveUnitRates, roughTotals, priceBand, counts, sumByKind,
} from './rough-calc.js?v=33';

const COL = 'roughEstimates';
const ref = (id) => doc(db, COL, id);
const sub = (id, name) => collection(db, COL, id, name);

// ---------- 率と単価の3段階を解く ----------
// 会社の標準（settings） → 元請けごと（customers/{id}.rates） → この見積だけ（rough.rates）
export function ratesFor(rough, customerName) {
  const customer = (cache.customers || []).find((c) => c.name === (customerName ?? rough?.customer));
  return {
    rates: resolveRates(
      { ...DEFAULT_RATES, ...cache.rates },
      customer?.rates,
      rough?.rates,
    ),
    unitRates: resolveUnitRates(
      { ...DEFAULT_UNIT_RATES, ...cache.unitRates },
      customer?.unitRates,
      rough?.unitRates,
    ),
  };
}

// 焼き付け済みなら焼き付けた方を必ず使う（保存後は設定を変えても動かない）
export function effectiveRates(rough, customerName) {
  if (rough?.ratesFrozen) {
    return { rates: rough.ratesFrozen, unitRates: rough.unitRatesFrozen || DEFAULT_UNIT_RATES };
  }
  return ratesFor(rough, customerName);
}

export function optionsFor(rough) {
  const { rates } = effectiveRates(rough);
  // 幅の上限倍率は率と同じ3段階（会社 → 元請け → この見積）で上書きできる。
  // 焼き付け済みならそのときの値を必ず使う（保存したら幅も動かない）。
  const uplift = typeof rough?.bandUpliftFrozen === 'number' ? rough.bandUpliftFrozen
    : typeof rates.bandUplift === 'number' ? rates.bandUplift
      : DEFAULT_ROUGH_OPTIONS.bandUplift;
  return {
    ...DEFAULT_ROUGH_OPTIONS,
    welfareOn: rough?.welfareOn !== false,
    bandUplift: uplift,
  };
}

// ---------- 概算見積そのもの ----------
export async function createRough(staffName, seed = {}) {
  const r = await addDoc(collection(db, COL), {
    projectName: seed.projectName || '',
    site: seed.site || '',
    customer: seed.customer || '',
    orderNo: seed.orderNo || '',
    staff: staffName || '',
    status: '見積中',
    oneLiner: seed.oneLiner || '',                       // 職人が打つ唯一の一言
    workType: WORK_TYPES.includes(seed.workType) ? seed.workType : WORK_TYPES[0],
    photos: [],                                          // {path,url,role,at}
    welfareOn: true,
    rates: null, unitRates: null,                        // この見積だけの上書き（無ければ null）
    ratesFrozen: null, unitRatesFrozen: null,
    itemsCount: 0, decidedCount: 0, undecidedCount: 0, pendingCount: 0, openQuestions: 0,
    totalFinal: 0, bandLow: 0, bandHigh: 0,
    convertedEstimateId: null,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  return r.id;
}

export function subscribeRough(id, cb) {
  return onSnapshot(ref(id), (s) => cb(s.exists() ? { id: s.id, ...s.data() } : null));
}

export function subscribeRoughItems(id, cb) {
  return onSnapshot(query(sub(id, 'items'), orderBy('order')), (s) =>
    cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

export function subscribeRoughQuestions(id, cb) {
  return onSnapshot(query(sub(id, 'questions'), orderBy('order')), (s) =>
    cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

export function subscribeRoughList(cb) {
  return onSnapshot(query(collection(db, COL), orderBy('updatedAt', 'desc')), (s) =>
    cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

export async function updateRough(id, patch) {
  await updateDoc(ref(id), { ...patch, updatedAt: serverTimestamp() });
}

export async function deleteRough(id) {
  // 子コレクションは残ると迷子になるので先に消す
  for (const name of ['items', 'questions', 'sketches', 'chat']) {
    const snap = await getDocs(sub(id, name));
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
  }
  await deleteDoc(ref(id));
}

// ---------- 項目 ----------
// 「AIの金額はそのまま合計に入れない」ので、AIが出した項目は必ず state:'未確定' で入る。
export function newItem(kind, patch = {}) {
  if (!ITEM_KINDS.includes(kind)) throw new Error('kind が不正: ' + kind);
  return {
    kind,
    name: '',
    state: '未確定',
    chosen: null,
    source: 'ai',                 // 'ai' | 'human' | 'sketch' | 'memory'
    order: Date.now(),
    steps: [],
    marketAmount: null,
    manualAmount: null,
    ...patch,
  };
}

export async function addItem(roughId, item) {
  const r = await addDoc(sub(roughId, 'items'), newItem(item.kind, item));
  return r.id;
}

export async function addItems(roughId, items) {
  const ids = [];
  let order = Date.now();
  for (const it of items) ids.push(await addItem(roughId, { ...it, order: order++ }));
  return ids;
}

export async function updateItem(roughId, itemId, patch) {
  await updateDoc(doc(db, COL, roughId, 'items', itemId), patch);
}

export async function deleteItem(roughId, itemId) {
  await deleteDoc(doc(db, COL, roughId, 'items', itemId));
}

export async function reorderItems(roughId, orderedIds) {
  await Promise.all(orderedIds.map((id, i) =>
    updateDoc(doc(db, COL, roughId, 'items', id), { order: i })));
}

// ---------- 決める（この3つだけが合計を動かす） ----------
// ［この金額を使う］
export async function decideItem(roughId, itemId, source, staffName) {
  await updateItem(roughId, itemId, {
    state: '確定', chosen: source,
    decidedBy: staffName || '', decidedAt: serverTimestamp(),
  });
}

// ［金額を直す］理由は覚えることに回すので呼び出し側で rough-memory に渡す
export async function overrideItemAmount(roughId, itemId, amount, staffName, reason = '') {
  await updateItem(roughId, itemId, {
    manualAmount: amount, state: '確定', chosen: 'manual',
    decidedBy: staffName || '', decidedAt: serverTimestamp(), reason,
  });
}

// ［単価待ちにする］合計に入らない。件数だけ出る。止まらずに先へ進める
export async function markPending(roughId, itemId, note = '') {
  await updateItem(roughId, itemId, {
    state: '単価待ち', chosen: null, pendingNote: note,
  });
}

export async function clearDecision(roughId, itemId) {
  await updateItem(roughId, itemId, { state: '未確定', chosen: null });
}

// ---------- 手順（項目のくわしい中身） ----------
// 小さいので配列で持つ。「使わない」は行を消さずに enabled:false にする。
export function newStep(patch = {}) {
  return { name: '', trade: '', persons: null, hours: null, enabled: true, source: 'ai', ...patch };
}

export async function setSteps(roughId, itemId, steps) {
  await updateItem(roughId, itemId, { steps });
}

export async function addStep(roughId, itemId, step, currentSteps) {
  await setSteps(roughId, itemId, [...(currentSteps || []), newStep(step)]);
}

export async function toggleStep(roughId, itemId, index, currentSteps, enabled) {
  const steps = (currentSteps || []).map((s, i) => (i === index ? { ...s, enabled } : s));
  await setSteps(roughId, itemId, steps);
}

export async function updateStep(roughId, itemId, index, currentSteps, patch) {
  const steps = (currentSteps || []).map((s, i) => (i === index ? { ...s, ...patch } : s));
  await setSteps(roughId, itemId, steps);
}

// ---------- ききたいこと ----------
// AIが自信のないところ。答えるまで残るが、答えなくても先へ進める。
export async function addQuestion(roughId, q) {
  const r = await addDoc(sub(roughId, 'questions'), {
    order: Date.now(),
    text: '', about: '', kind: 'choice',      // 'choice' | 'photo' | 'free'
    options: [], answer: null, itemId: null,
    answeredBy: null, answeredAt: null,
    ...q,
  });
  return r.id;
}

export async function answerQuestion(roughId, qid, answer, staffName) {
  await updateDoc(doc(db, COL, roughId, 'questions', qid), {
    answer, answeredBy: staffName || '', answeredAt: serverTimestamp(),
  });
}

export async function deleteQuestion(roughId, qid) {
  await deleteDoc(doc(db, COL, roughId, 'questions', qid));
}

// ---------- 写真 ----------
// role: '現場' | '図面' | '銘板'。一致しても元の写真は必ず残す（消すのは人が押したときだけ）。
export async function uploadPhoto(roughId, file, role = '現場') {
  const safe = String(file.name || 'photo').replace(/[^\w.-]/g, '_').slice(-40);
  const path = `roughPhotos/${roughId}/${Date.now()}_${safe}`;
  const sref = storageRef(storage, path);
  await uploadBytes(sref, file);
  const url = await getDownloadURL(sref);
  const snap = await getDoc(ref(roughId));
  const photos = [...(snap.data()?.photos || []), { path, url, role, at: Date.now() }];
  await updateRough(roughId, { photos });
  return { path, url, role };
}

export async function removePhoto(roughId, path) {
  const snap = await getDoc(ref(roughId));
  const photos = (snap.data()?.photos || []).filter((p) => p.path !== path);
  await updateRough(roughId, { photos });
  try { await deleteObject(storageRef(storage, path)); }
  catch (e) { console.warn('写真の実体を消せませんでした（一覧からは外れています）:', e); }
}

// ---------- スケッチ ----------
export async function addSketch(roughId, sketch) {
  const r = await addDoc(sub(roughId, 'sketches'), {
    prompt: '', sourcePath: null, sourceUrl: null, resultPath: null, resultUrl: null,
    proposedItems: [], by: '', at: serverTimestamp(), ...sketch,
  });
  return r.id;
}

// ---------- 見積の中のやりとり ----------
// 単独のチャット画面は作らない。見積にくっつけて残す。
// ここは学習に回さない（覚えることは rough-memory.js の2つだけ）。
export async function addChatMessage(roughId, msg) {
  await addDoc(sub(roughId, 'chat'), {
    role: 'user', text: '', by: '', at: serverTimestamp(), changedItems: [], ...msg,
  });
}

export function subscribeChat(roughId, cb) {
  return onSnapshot(query(sub(roughId, 'chat'), orderBy('at')), (s) =>
    cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

// ---------- 集計を見積ドキュメントに写す ----------
// 一覧が明細を読まずに件数と金額を出せるように。store.js の saveSummary と同じ考え方。
export async function saveRoughSummary(roughId, rough, items) {
  const { rates, unitRates } = effectiveRates(rough);
  const opts = optionsFor(rough);
  const t = roughTotals(items, rates, unitRates, opts);
  const band = priceBand(items, rates, unitRates, opts);
  const c = counts(items);
  await updateRough(roughId, {
    itemsCount: c.items,
    decidedCount: c.decided,
    undecidedCount: c.undecided,
    pendingCount: c.pending,
    totalFinal: Math.round(t.withTax),
    bandLow: band.displayLow,
    bandHigh: band.displayHigh,
  });
  return { totals: t, band };
}

// ---------- 焼き付け（保存したら金額は動かない） ----------
export async function freezeRough(roughId, rough, items, staffName) {
  const { rates, unitRates } = ratesFor(rough);
  const opts = optionsFor(rough);
  const t = roughTotals(items, rates, unitRates, opts);
  const band = priceBand(items, rates, unitRates, opts);
  await updateRough(roughId, {
    ratesFrozen: rates,
    unitRatesFrozen: unitRates,
    bandUpliftFrozen: opts.bandUplift,
    totalsFrozen: t,
    bandFrozen: { low: band.displayLow, high: band.displayHigh },
    frozenBy: staffName || '',
    frozenAt: serverTimestamp(),
  });
  return { totals: t, band };
}

// ---------- 元請けごとの率・単価を覚える（「次からも使う」） ----------
// 元請けを先に登録する画面は作らない。ここを押したものだけが増える。
// 履歴には「東レ愛媛 / 現場工事 / 4,000→3,800 / 野村 / 理由」を欄ごとに残す。

// 率を1つ上書き（例: 諸経費 15% → 12%）
export async function saveCustomerRate(customerName, key, value, { label, staff, reason } = {}) {
  const c = requireCustomer(customerName);
  const before = c.rates?.[key];
  await updateDoc(doc(db, 'customers', c.id), { rates: { ...(c.rates || {}), [key]: value } });
  await recordRateChange({
    scope: 'customer', target: customerName, key,
    label: label || key, unit: '%',
    from: typeof before === 'number' ? before * 100 : null,
    to: typeof value === 'number' ? value * 100 : null,
    staff, reason,
  });
}

// 職種の1h単価を1つ上書き（例: 現場工事 4,000 → 3,800）
export async function saveCustomerTradeRate(customerName, tradeName, rate, { staff, reason } = {}) {
  const c = requireCustomer(customerName);
  const trades = [...(c.unitRates?.trades || [])];
  const i = trades.findIndex((t) => t.name === tradeName);
  const before = i >= 0 ? trades[i].rate
    : (cache.unitRates.trades || []).find((t) => t.name === tradeName)?.rate ?? null;
  if (i >= 0) trades[i] = { ...trades[i], rate };
  else trades.push({ name: tradeName, rate });
  await updateDoc(doc(db, 'customers', c.id), { unitRates: { ...(c.unitRates || {}), trades } });
  await recordRateChange({
    scope: 'customer', target: customerName, key: tradeKey(tradeName),
    label: tradeName, unit: '円/h', from: before, to: rate, staff, reason,
  });
}

// 元請けの上書きを1つ消して、標準に戻す
export async function clearCustomerRate(customerName, key, { label, staff, reason } = {}) {
  const c = requireCustomer(customerName);
  const rates = { ...(c.rates || {}) };
  const before = rates[key];
  delete rates[key];
  await updateDoc(doc(db, 'customers', c.id), { rates });
  await recordRateChange({
    scope: 'customer', target: customerName, key, label: label || key, unit: '%',
    from: typeof before === 'number' ? before * 100 : null,
    to: null, staff, reason: reason || '標準に戻した',
  });
}

// ---------- 法定福利費を分けて書く（元請けの書式指定） ----------
// 【既定は false。元請けへの確認が済むまで誰も true にしない】
// 公共工事では法定福利費を分けて書くよう求められることがある
// （AI見積_仕様と準備メモ 第3部 4 — 住友重機械エンバイロメント等に要確認）。
// これは「書き方」の指定であって計算は変わらない。金額には一切効かせていない。
export async function setSeparateWelfare(customerName, on, { staff, reason } = {}) {
  const c = requireCustomer(customerName);
  await updateDoc(doc(db, 'customers', c.id), { separateWelfare: !!on });
  await recordRateChange({
    scope: 'customer', target: customerName, key: 'separateWelfare',
    label: '法定福利費を分けて書く', unit: '',
    from: c.separateWelfare ? 1 : 0, to: on ? 1 : 0, staff, reason,
  });
}

export function separatesWelfare(customerName) {
  const c = (cache.customers || []).find((x) => x.name === customerName);
  return c?.separateWelfare === true;
}

function requireCustomer(name) {
  const c = (cache.customers || []).find((x) => x.name === name);
  if (!c) throw new Error('取引先が見つかりません: ' + name);
  return c;
}

// ---------- 概算 → 本見積 ----------
// 概算は消さない。引き継いだ先の id だけ書いておく（あとで差を見るため）。
export async function convertToEstimate(roughId, rough, items, staffName) {
  const { rates, unitRates } = effectiveRates(rough);
  // 写真は本見積へそのまま引き継ぐ（確認画面の「そのまま引き継ぐもの」に入っている）。
  // Storage の実体は roughPhotos/ のまま共有する。二重に上げない。
  // ※概算側で写真を消すと本見積からも消える。消すのは人が押したときだけなので、それでよい。
  const photos = (rough.photos || []).map((p) => p.url).filter(Boolean);
  const est = await addDoc(collection(db, 'estimates'), {
    projectName: rough.projectName || '',
    site: rough.site || '',
    customer: rough.customer || '',
    orderNo: rough.orderNo || '',
    staff: staffName || rough.staff || '',
    status: '見積中',
    welfareOn: rough.welfareOn !== false,
    ratesEdited: false,
    rates: { ...rates },
    unitRates: { travelLabor: unitRates.travelLabor, kmRate: unitRates.kmRate },
    adjust: 0, sketchPhotos: photos,
    linesCount: 0, pendingCount: 0, totalFinal: 0,
    fromRoughId: roughId,
    // お客様に伝えた幅。本見積がこの中に収まっているかの判定に使う
    roughBand: rough.bandFrozen || null,
    roughTotal: rough.totalsFrozen?.withTax ?? rough.totalFinal ?? null,
    roughDate: rough.frozenAt || rough.updatedAt || null,
    // 費目ごとの概算。本見積の「概算との差」の表に出す
    roughKinds: roughKindsOf(rough, items, rates, unitRates),
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });

  let order = Date.now();
  for (const it of items) {
    const line = roughItemToLine(it, rates, unitRates);
    if (line) await addDoc(collection(db, 'estimates', est.id, 'lines'), { ...line, order: order++ });
  }
  await updateRough(roughId, { convertedEstimateId: est.id });
  return est.id;
}

// 概算の費目別（税抜・計上金額）。焼き付け済みならそれを使う。
// 本見積画面の「概算との差」の表がこれを見る。
function roughKindsOf(rough, items, rates, unitRates) {
  const f = rough.totalsFrozen;
  if (f) return { material: f.material, labor: f.labor, travel: f.travel, subcontract: f.subcontract };
  const k = sumByKind(items, rates, unitRates, 'final');
  return { material: k.材料, labor: k.労務, travel: k.移動, subcontract: k.外注 };
}

// 概算の材料は「一式いくら」。本見積では1本ずつに割り直す。
// どの材料行が割り直し待ちで、元は何だったのかを残す。
//   'market'  相場を採用したもの   … あとで「相場はどれくらい外れていたか」を見る
//   'manual'  金額を手で直したもの … 同上。直した人の見立てが当たったか
//   'pending' 単価待ち（金額なし） … 割り直して初めて金額がつく
export const MATERIAL_ORIGINS = ['market', 'manual', 'pending'];

export function materialOriginOf(item) {
  if (item.kind !== '材料') return null;
  if (item.state === '単価待ち') return 'pending';
  if (item.chosen === 'market') return 'market';
  if (item.chosen === 'manual') return 'manual';
  return null;   // よつばの単価を採ったものは、もう1本ずつになっている
}

// 概算の項目 → 本見積の明細行。
// 相場・人が直した金額は「売値」なので、本見積側で同じ金額になるよう
// 原価に割り戻して手打ち行（✎）にする。拾い出しでちゃんと積み直す前提の仮置き。
export function roughItemToLine(item, rates, unitRates) {
  const pending = item.state === '単価待ち';
  const base = { name: item.name || '', handwritten: false, pendingPrice: pending, fromRoughItem: true };

  if (item.kind === '労務') {
    return {
      ...base, kind: '労務',
      name: item.trade || item.name || '',
      trade: item.trade || '',
      persons: item.persons ?? 0,
      hours: item.hours ?? 0,
      rate: item.rate ?? (unitRates.trades || []).find((t) => t.name === item.trade)?.rate ?? 0,
    };
  }
  if (item.kind === '移動') {
    const l = { ...base, kind: '移動', persons: item.persons ?? 0, hours: item.hours ?? 0 };
    if (typeof item.km === 'number') l.km = item.km;
    return l;
  }
  if (item.kind === '外注') {
    return { ...base, kind: '外注', amount: item.amount ?? item.manualAmount ?? 0, supplier: item.supplier || '' };
  }
  // 材料
  const origin = materialOriginOf(item);
  if (origin) {
    const sell = origin === 'market' ? item.marketAmount
      : origin === 'manual' ? item.manualAmount : null;
    const cost = typeof sell === 'number' ? sell / (1 + (rates.material || 0)) : 0;
    return {
      ...base, kind: '材料', itemId: null, qty: 1, unit: '式', cost,
      handwritten: true, supplier: '',
      // 割り直しの対象。1本ずつに割り終わったら画面側で false にする
      needsBreakdown: true,
      roughOrigin: {
        itemId: item.id || null,
        name: item.name || '',
        priceSource: origin,                                   // market / manual / pending
        amount: typeof sell === 'number' ? sell : null,         // 概算での計上金額（税抜・売値）
        reason: item.reason || '',                              // 手で直したときの一言
        decidedBy: item.decidedBy || '',
      },
    };
  }
  return {
    ...base, kind: '材料', itemId: item.itemId || null,
    qty: item.qty ?? 0, unit: item.unit || '', cost: item.cost ?? 0,
    supplier: item.supplier || '',
  };
}

// ---------- 相場はどれくらい外れていたか ----------
// 割り直したあとの本見積の行と、概算で採った金額を比べる。
// 実績が溜まるまでのあいだ、相場を信じてよいかの手がかりになる。
export function originVariance(line, rates) {
  const o = line?.roughOrigin;
  if (!o || typeof o.amount !== 'number') return null;
  const actual = typeof line.cost === 'number' && typeof line.qty === 'number'
    ? line.qty * line.cost * (1 + (rates.material || 0))
    : null;
  if (actual == null) return null;
  return {
    priceSource: o.priceSource,
    name: o.name,
    guessed: o.amount,                                  // 概算で採った金額
    actual,                                             // 割り直したあとの金額
    diff: actual - o.amount,
    rate: o.amount === 0 ? null : (actual - o.amount) / o.amount,
  };
}
