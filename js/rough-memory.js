// ============================================================
// 覚えること — アプリが例外を覚える（人に規則を守らせない）
//
// 覚えるのはこの2つだけ。
//   ① 項目を足す（錆落とし・足場・試運転など）… 3件たまったら自動
//   ② 金額・単価を直す                        … 直した本人が押す。理由を一言
//
// チャットの会話そのものは残らない。使われたものだけが残る。
// 社長の承認は挟まない。現場で客と話した人が決める。
// 覚えたことは一覧に出る（誰が・いつ・なぜ）。いつでも消せる。
// ============================================================

import {
  db, collection, doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  onSnapshot, query, orderBy, serverTimestamp, increment, arrayUnion,
} from './firebase.js?v=33';
import { norm } from './store.js?v=33';

// 3件たまったら自動。ここを変えれば効き方が変わる
export const ADOPT_AFTER = 3;

const ITEMS = 'memoryItems';
const PRICES = 'memoryPrices';

// Firestore のドキュメントIDに使えるようにする（同じものを2つ作らないため決め打ちにする）
function keyOf(name, workType = '') {
  const k = `${norm(name)}__${norm(workType)}`;
  return k.replace(/[/\\.#$[\]]/g, '_').slice(0, 300) || '_';
}

// ============================================================
// ① 項目を足す
// ============================================================

// 人が項目を足したときに1回呼ぶ。3件たまったら adopted:true になり、
// 次からは同じ工事の種類で最初から並ぶようになる。
export async function recordItemAdded({ name, kind, trade, persons, hours, workType, roughId, staff }) {
  if (!name || !name.trim()) return null;
  const id = keyOf(name, workType);
  const dref = doc(db, ITEMS, id);
  const snap = await getDoc(dref);

  const occurrence = { roughId: roughId || '', staff: staff || '', at: Date.now() };

  if (!snap.exists()) {
    await setDoc(dref, {
      name: name.trim(), kind: kind || '労務', trade: trade || '',
      persons: persons ?? null, hours: hours ?? null,
      workType: workType || '',
      count: 1, adopted: false, adoptedAt: null, disabled: false,
      occurrences: [occurrence],
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    return { id, count: 1, adopted: false };
  }

  await updateDoc(dref, {
    count: increment(1),
    occurrences: arrayUnion(occurrence),
    updatedAt: serverTimestamp(),
    // 直近の人数・時間で上書きしておく（最後に使った形が次に出る）
    ...(persons != null ? { persons } : {}),
    ...(hours != null ? { hours } : {}),
  });

  const after = await getDoc(dref);
  const count = after.data()?.count || 0;
  const wasAdopted = after.data()?.adopted === true;
  if (!wasAdopted && count >= ADOPT_AFTER) {
    await updateDoc(dref, { adopted: true, adoptedAt: serverTimestamp() });
    return { id, count, adopted: true, justAdopted: true };
  }
  return { id, count, adopted: wasAdopted };
}

// 自動で並べる項目（3件たまったもの）。工事の種類で絞る
export async function adoptedItems(workType = null) {
  const snap = await getDocs(collection(db, ITEMS));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((m) => m.adopted && !m.disabled)
    .filter((m) => !workType || !m.workType || m.workType === workType)
    .sort((a, b) => (b.count || 0) - (a.count || 0));
}

// 覚えたことを、新しい概算の項目の形にする（state は必ず '未確定'。押すまで合計に入らない）
export function adoptedToItem(memory) {
  return {
    kind: memory.kind || '労務',
    name: memory.name,
    trade: memory.trade || '',
    persons: memory.persons ?? null,
    hours: memory.hours ?? null,
    state: '未確定',
    chosen: null,
    source: 'memory',
    memoryId: memory.id,
  };
}

// ============================================================
// ② 金額・単価を直す
// ============================================================

// 直した本人が押したときだけ呼ぶ。理由は必須（3か月後の自分と他の4人のため）。
export async function recordPriceEdit({ name, kind, amount, unit, reason, staff, roughId }) {
  const why = String(reason || '').trim();
  if (!why) throw new Error('理由を一言入れてください');
  if (!name || !name.trim()) throw new Error('品名がありません');

  const id = keyOf(name);
  await setDoc(doc(db, PRICES, id), {
    name: name.trim(), kind: kind || '材料',
    amount: typeof amount === 'number' ? amount : null,
    unit: unit || '',
    reason: why.slice(0, 100),
    staff: staff || '', roughId: roughId || '',
    disabled: false,
    at: serverTimestamp(),
  }, { merge: true });
  return id;
}

// 同じ品名を次に出すときの金額（あれば）
export async function rememberedPrice(name) {
  if (!name) return null;
  const snap = await getDoc(doc(db, PRICES, keyOf(name)));
  if (!snap.exists()) return null;
  const d = snap.data();
  return d.disabled ? null : { id: snap.id, ...d };
}

// ============================================================
// 一覧と、消すこと
// ============================================================

export function subscribeMemoryItems(cb) {
  return onSnapshot(query(collection(db, ITEMS), orderBy('updatedAt', 'desc')), (s) =>
    cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

export function subscribeMemoryPrices(cb) {
  return onSnapshot(query(collection(db, PRICES), orderBy('at', 'desc')), (s) =>
    cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

// 「いつでも消せる」。数え直しの記録ごと消す
export async function forgetItem(id) { await deleteDoc(doc(db, ITEMS, id)); }
export async function forgetPrice(id) { await deleteDoc(doc(db, PRICES, id)); }

// 消さずに止めるだけ（また使うかもしれないとき）
export async function disableItem(id, disabled = true) {
  await updateDoc(doc(db, ITEMS, id), { disabled });
}
export async function disablePrice(id, disabled = true) {
  await updateDoc(doc(db, PRICES, id), { disabled });
}
