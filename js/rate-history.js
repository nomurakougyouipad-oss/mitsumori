// ============================================================
// 率と労務単価の変更履歴 — 誰が・いつ・何を・なぜ
//
// 承認は挟まない。全員が変えられる。ただし履歴には必ず残る（CLAUDE.md）。
// 画面「設定 — 率と労務単価」はこの1行をそのまま出す:
//
//   2026/8/6  東レ愛媛  現場工事 4,000→3,800  野村
//             「今年度から単価が下がった」
//
// なので日付・対象・項目・旧値・新値・担当・理由を、それぞれ別の欄で持つ。
// （文字列に組み立てて1つの欄に入れると、あとで並べ替えも絞り込みもできない）
//
// 置き場所は settings/rates/history。追記のみで、書き換えも消しもできない。
// ============================================================

import {
  db, collection, addDoc, getDocs, onSnapshot, query, orderBy, limit, Timestamp,
} from './firebase.js?v=33';

const COL = () => collection(db, 'settings', 'rates', 'history');

// 何に対する変更か
export const SCOPES = ['standard', 'customer'];   // 会社の標準 / 元請けごと

// key の付け方: 率は 'overhead' などそのまま、職種単価は 'trade:現場工事'
export const tradeKey = (name) => 'trade:' + name;
export const isTradeKey = (key) => String(key || '').startsWith('trade:');
export const tradeNameOf = (key) => String(key || '').slice(6);

// 1件残す。理由は任意（率の変更は理由なしでも残す。単価の上書きは画面側で必須にする）
export async function recordRateChange({ scope, target, key, label, from, to, staff, reason, unit }) {
  if (!SCOPES.includes(scope)) throw new Error('scope が不正: ' + scope);
  if (!key) throw new Error('key がありません');
  await addDoc(COL(), {
    at: Timestamp.now(),
    scope,                              // 'standard' | 'customer'
    target: scope === 'customer' ? String(target || '') : '',   // 元請け名（標準なら空）
    key: String(key),                   // 'overhead' / 'trade:現場工事'
    label: String(label || key),        // 画面に出す名前『諸経費』『現場工事』
    from: typeof from === 'number' ? from : null,
    to: typeof to === 'number' ? to : null,
    unit: unit || '',                   // '%' / '円/h' / '円/km'
    staff: String(staff || ''),
    reason: String(reason || '').slice(0, 100),
  });
}

// 画面に出す1行ぶんに整える。古い行（scope が無い時代のもの）は標準として扱う
export function describe(h) {
  const scope = SCOPES.includes(h.scope) ? h.scope : 'standard';
  return {
    at: h.at,
    who: h.staff || '—',
    where: scope === 'customer' && h.target ? h.target : '標準',
    what: h.label || h.key || '',
    from: h.from,
    to: h.to,
    unit: h.unit || '',
    reason: h.reason || '',
    scope,
  };
}

export function subscribeHistory(cb, max = 50) {
  return onSnapshot(query(COL(), orderBy('at', 'desc'), limit(max)), (s) =>
    cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

export async function fetchHistory(max = 50) {
  const s = await getDocs(query(COL(), orderBy('at', 'desc'), limit(max)));
  return s.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// 元請けごとの履歴だけ（「元請けごと」タブ用）
export function forCustomer(list, customerName) {
  return (list || []).filter((h) => h.scope === 'customer' && h.target === customerName);
}
