// ============================================================
// 実績（完工） — ここが埋まると「よつばの金額」で概算が出せるようになる
//
// いまは一式見積の実績が0件。相場でしか出せない。
// 使いはじめた日から溜めないと、半年後にまた0件になる。
//
// 【上書きしない】概算・本見積・実績はそれぞれ別に残す。
//   実績は estimates の中の数字を書き換えるのではなく、actuals に1件足す。
//   そのとき概算と本見積の税込を焼き付けて持つので、
//   あとで設定や見積を触っても「そのとき出した金額との差」は動かない。
//
// 【見積が無くても入れられる】
//   社長の記憶から過去の工事を10〜20件入れる用（AI見積_仕様と準備メモ 第3部 5）。
//   そのとき必要なのは4つだけ。注番も工事名も要らない。
//     工事の種類 ／ 何人で何日 ／ 材料はいくら ／ 最終の請求金額
//   例: モーター整備、2人で5日、材料35万、請求148万
// ============================================================

import {
  db, collection, doc, addDoc, updateDoc, deleteDoc, getDoc,
  onSnapshot, query, orderBy, serverTimestamp, Timestamp,
} from './firebase.js?v=2';
import { WORK_TYPES } from './rough-calc.js?v=2';

const COL = 'actuals';

// どこから入れた実績か
export const ACTUAL_SOURCES = ['app', 'memory'];   // アプリの見積から / 過去を思い出して

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

// ---------- 1件つくる ----------
// seed には見積から拾える分を入れておく。人が打つのは請求額と完工日だけで済む。
export function newActual(seed = {}) {
  return {
    workType: WORK_TYPES.includes(seed.workType) ? seed.workType : WORK_TYPES[0],
    projectName: seed.projectName || '',
    customer: seed.customer || '',
    // 過去を思い出して入れるときの4つ
    persons: num(seed.persons),
    days: num(seed.days),
    materialCost: num(seed.materialCost),
    billedAmount: num(seed.billedAmount),      // 最終の請求金額（税込）
    completedAt: seed.completedAt || null,     // 完工日
    // どの見積から来たか（無くてよい）
    roughId: seed.roughId || null,
    estimateId: seed.estimateId || null,
    // そのとき出した金額を焼き付ける。あとで見積を触っても差は動かない
    roughTotal: num(seed.roughTotal),
    estimateTotal: num(seed.estimateTotal),
    staff: seed.staff || '',
    note: seed.note || '',
    source: ACTUAL_SOURCES.includes(seed.source) ? seed.source : 'app',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

export async function addActual(seed) {
  const r = await addDoc(collection(db, COL), newActual(seed));
  return r.id;
}

export async function updateActual(id, patch) {
  await updateDoc(doc(db, COL, id), { ...patch, updatedAt: serverTimestamp() });
}

export async function deleteActual(id) {
  await deleteDoc(doc(db, COL, id));
}

export function subscribeActuals(cb) {
  return onSnapshot(query(collection(db, COL), orderBy('completedAt', 'desc')), (s) =>
    cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

// ---------- 差（一覧に出す） ----------
//   概算 ￥1,457,280 → 実績 ￥1,398,000（−59,280）
// 差 = 実績 − そのとき出した金額。マイナスなら安く上がった。
export function diffOf(actual) {
  const billed = num(actual?.billedAmount);
  const rough = num(actual?.roughTotal);
  const est = num(actual?.estimateTotal);
  return {
    billed,
    vsRough: billed != null && rough != null ? billed - rough : null,
    vsEstimate: billed != null && est != null ? billed - est : null,
    roughTotal: rough,
    estimateTotal: est,
  };
}

// 割合（+12% のように出したいとき）。元が0やnullなら null
export function diffRate(diff, base) {
  const b = num(base);
  if (diff == null || b == null || b === 0) return null;
  return diff / b;
}

// ---------- 完工にする ----------
// 見積を消さない。status を '完工' にして、実績を1件足し、両方をリンクで結ぶ。
export async function completeEstimate({ estimateId, roughId, billedAmount, completedAt, staff, note }) {
  const seed = { estimateId: estimateId || null, roughId: roughId || null, staff, note,
    billedAmount: num(billedAmount),
    completedAt: completedAt instanceof Date ? Timestamp.fromDate(completedAt) : (completedAt || Timestamp.now()),
    source: 'app' };

  // そのとき出した金額を、いま読んで焼き付ける
  if (estimateId) {
    const s = await getDoc(doc(db, 'estimates', estimateId));
    if (s.exists()) {
      const d = s.data();
      seed.estimateTotal = num(d.totalFinal);
      seed.projectName = d.projectName || '';
      seed.customer = d.customer || '';
      if (!roughId && d.fromRoughId) seed.roughId = d.fromRoughId;
    }
  }
  if (seed.roughId) {
    const s = await getDoc(doc(db, 'roughEstimates', seed.roughId));
    if (s.exists()) {
      const d = s.data();
      // 焼き付け済みの税込を優先する（保存したときの金額）
      seed.roughTotal = num(d.totalsFrozen?.withTax) ?? num(d.totalFinal);
      seed.workType = d.workType || seed.workType;
      if (!seed.projectName) seed.projectName = d.projectName || '';
      if (!seed.customer) seed.customer = d.customer || '';
    }
  }

  const actualId = await addActual(seed);

  // 見積側は status と リンクだけ。金額は書き換えない
  if (estimateId) {
    await updateDoc(doc(db, 'estimates', estimateId), {
      status: '完工', actualId, completedAt: seed.completedAt, updatedAt: serverTimestamp(),
    });
  }
  if (seed.roughId) {
    await updateDoc(doc(db, 'roughEstimates', seed.roughId), {
      status: '完工', actualId, updatedAt: serverTimestamp(),
    });
  }
  return actualId;
}

// ---------- 溜まった実績を引く ----------
// 「この工事の種類なら、よつばはいくらだったか」。件数が少ないうちは null を返す。
export const ENOUGH_SAMPLES = 3;

export function summarizeByWorkType(actuals, workType) {
  const list = (actuals || []).filter((a) =>
    (!workType || a.workType === workType) && num(a.billedAmount) != null);
  if (list.length < ENOUGH_SAMPLES) {
    return { count: list.length, enough: false, median: null, min: null, max: null };
  }
  const amounts = list.map((a) => a.billedAmount).sort((x, y) => x - y);
  const mid = Math.floor(amounts.length / 2);
  const median = amounts.length % 2 ? amounts[mid] : (amounts[mid - 1] + amounts[mid]) / 2;
  return {
    count: amounts.length, enough: true,
    median, min: amounts[0], max: amounts[amounts.length - 1],
  };
}

// 人日あたりいくらだったか（人工の見当をつけるのに使う）
export function perManDay(actual) {
  const billed = num(actual?.billedAmount);
  const p = num(actual?.persons);
  const d = num(actual?.days);
  if (billed == null || p == null || d == null || p * d === 0) return null;
  return billed / (p * d);
}
