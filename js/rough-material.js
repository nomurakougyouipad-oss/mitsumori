// ============================================================
// 材料を本数で数える — 総量（60m）→ 定尺4m × 15本
//
// 【なぜ本数か】2026/8/8 現場より
//   ・単価マスターは「1本いくら」で持っている（単位が「本」）
//   ・材料を注文するのは本数
//   ・端数が出るかどうかが金額に効く（58mでも4mが15本要る）
//
// 【定尺はどこにあるか】単価マスターの品名がすでに持っている。
//     TP-A(SUS304) 40Ax3mmx4000   → 4000mm ＝ 4m
//     SGP(溶協品)  100Ax5.5m       → 5.5m
//   材料によって定尺が違う（ステンレス配管4m／炭素鋼の配管5.5m）ので決め打ちにしない。
//   **別表を作らないこと。** 設定画面などに定尺表を持つと、マスターとズレる。
//   ズレたほうが正になった瞬間、単価の引けない品名ができる。マスターが正。
//
// 【呼び径だけで決める】2026/8/8 現場確認
//   肉厚で定尺は変わらない。40Aなら4m。だから定尺は 種類×呼び径 で引く。
//   材質も見ない（定尺は材質で変わらない）。
//   そのおかげで、肉厚や材質がまだ決まっていない概算の段階でも本数だけは出せる（芯2）。
//
// 【単価はもっと厳しく引く】肉厚が違えば単価は違う。
//   種類×材質×呼び径×定尺 で、生きている行が1つに絞れたときだけ入れる。
//   絞れないものは単価待ち。「間違ってつなぐより、聞くほうが安い」（CLAUDE.md）。
// ============================================================

import { CATALOG_KINDS, parseItemName } from './catalog.js?v=33';

// 定尺とみなす最短（m）。JISの最短は4m、配管(SGP)は5.5m。
// マスターには 500 / 550 / 1000 も入っているが、それは端材か特注で定尺ではない
//（2026/8/8 現場確認）。3mで切れば定尺だけが残る。
export const MIN_STOCK_M = 3;

// 呼び径（寸法の1桁目）だけで定尺が決まる種類。
// 配管は 40A・100A のように呼び径が1桁目に来る。肉厚は2桁目で、定尺には効かない。
const BORE_KINDS = new Set(['sgp', 'tpa', 'pipe']);

// 長さで数える単位。これ以外（枚・個・式）は本数に直さず、そのまま数える
const LENGTH_UNITS = { m: 1, ｍ: 1, M: 1, メートル: 1, mm: 0.001, ｍｍ: 0.001, cm: 0.01 };

export const isLengthUnit = (u) => Object.prototype.hasOwnProperty.call(LENGTH_UNITS, String(u || '').trim());
export const toMeters = (v, u) => {
  const k = LENGTH_UNITS[String(u || '').trim()];
  return (k == null || !isFinite(v)) ? null : v * k;
};

// マスターの長さの桁をメートルに直す。種類によって書き方が違う
//   TP-A … 4000（mm表記）  ／ SGP … 5.5（m表記）
// 100以上ならmm、未満ならmとみなす。5.5m と 4000mm の両方が正しく読める
export function lengthMeters(v) {
  const n = parseFloat(v);
  if (!isFinite(n) || n <= 0) return null;
  return n >= 100 ? n / 1000 : n;
}

// 「40A」→ ['40'] ／「L-6x65x65」→ ['6','65','65']
export const numsOf = (s) => String(s || '').match(/\d+(?:\.\d+)?/g) || [];

// ---------- 単価マスターを、寸法の数字で引ける形にする ----------
// 使用停止の行は入れない。入れると、生きていない品名の定尺を拾ってしまう
// （実データ: TP-A 40Ax3mm の4行はすべて使用停止。生きているのは 40Ax4mmx4000 だけ）
export function materialRows(master) {
  const out = [];
  for (const it of (master || [])) {
    if (!it || it.discontinued) continue;
    const p = parseItemName(it.name);
    const def = CATALOG_KINDS.find((d) => d.heads.includes(p.head));
    if (!def || !p.dims) continue;
    const nums = numsOf(p.dims);
    if (nums.length < 2) continue;                 // 長さの桁が無いものは対象外
    out.push({
      item: it,
      kindKey: def.key,
      material: p.material || '',
      shape: nums.slice(0, -1),                    // 長さ以外の桁
      lenValue: nums[nums.length - 1],
      meters: lengthMeters(nums[nums.length - 1]),
    });
  }
  return out;
}

// 種類の呼び名（AIには CATALOG_KINDS の label をそのまま選ばせる）
export const materialKindLabels = (master) => {
  const live = new Set(materialRows(master).map((r) => r.kindKey));
  return CATALOG_KINDS.filter((d) => live.has(d.key)).map((d) => d.label);
};

export function kindKeyOf(label) {
  const s = String(label || '').trim();
  if (!s) return null;
  const d = CATALOG_KINDS.find((x) => x.label === s || x.key === s || x.heads.includes(s));
  return d ? d.key : null;
}

// ---------- 定尺の候補（長い順） ----------
// 呼び径（配管）または形（アングル等）が合う行を集め、長さだけを見る。
// 材質は見ない。定尺は材質で変わらないので、材質が分からなくても本数は出せる。
export function stockLengths(rows, kindKey, size) {
  const want = numsOf(size);
  if (!kindKey || !want.length) return [];
  const byLen = new Map();
  for (const r of rows) {
    if (r.kindKey !== kindKey) continue;
    const hit = BORE_KINDS.has(kindKey)
      ? r.shape[0] === want[0]                     // 呼び径だけ見る
      : r.shape.join('x') === want.join('x');      // 形材は形そのもの
    if (!hit) continue;
    if (!(r.meters >= MIN_STOCK_M)) continue;      // 端材・特注は定尺にしない
    const k = r.meters;
    byLen.set(k, [...(byLen.get(k) || []), r]);
  }
  return [...byLen.entries()]
    .map(([meters, rs]) => ({ meters, rows: rs }))
    .sort((a, b) => b.meters - a.meters);          // いちばん長いものを先頭に（既定）
}

// ---------- 本数 ----------
// 切り上げだけ。ロスの上乗せはしない（2026/8/8 決定）。
// 余分が要るときは現場が本数を直す。見積が黙って高くならないようにする。
export function piecesFor(totalM, stockM) {
  if (!(totalM > 0) || !(stockM > 0)) return null;
  return Math.ceil(totalM / stockM);
}

// ============================================================
// 材料の項目を「定尺 × 本数」に直す
//
//   入り: { matKind, matMaterial, matSize, totalQty, totalUnit }（AIが返したもの）
//   出  : { qty, unit, perLengthM, totalM, cost, name, why }
//
// 結び付かなかったものは総量のまま返す（qty は総量、unit は 'm' のまま）。
// **勝手に定尺を決めない。** why に理由を入れて、画面と「ききたいこと」に回す。
// ============================================================
export function resolveMaterial(master, spec) {
  const { matKind, matMaterial, matSize, totalQty, totalUnit } = spec || {};
  const qty = typeof totalQty === 'number' && isFinite(totalQty) ? totalQty : null;
  const base = { qty, unit: totalUnit || null, perLengthM: null, totalM: null, cost: null, name: null, stocks: [] };

  // 枚・個・式は、はじめから数える単位。本数に直さない
  if (!isLengthUnit(totalUnit)) return { ...base, why: '' };
  if (qty == null) return { ...base, why: '総量が分かりません' };

  const totalM = toMeters(qty, totalUnit);
  const kindKey = kindKeyOf(matKind);
  if (!kindKey) return { ...base, totalM, why: '材料の種類が単価マスターの分類に結び付きませんでした' };
  if (!numsOf(matSize).length) return { ...base, totalM, why: '呼び径（サイズ）が分かりません' };

  const rows = materialRows(master);
  const stocks = stockLengths(rows, kindKey, matSize);
  if (!stocks.length) {
    return { ...base, totalM, why: '単価マスターにこの呼び径の定尺がありません' };
  }

  // 既定はいちばん長い定尺（本数が減り、端数も減る）。くわしくで選び直せる
  const chosen = stocks[0];
  const pieces = piecesFor(totalM, chosen.meters);

  // ---------- 単価は絞れたときだけ ----------
  // 定尺は材質・肉厚で変わらないが、単価は変わる。
  // 材質が合い、生きている行が1つに絞れたときだけ入れる。
  // 絞れないものは単価待ちのまま先へ進める（芯2）。肉厚は「ききたいこと」で聞く
  const wantMat = String(matMaterial || '').trim();
  const sameMat = wantMat ? chosen.rows.filter((r) => r.material === wantMat) : [];
  const only = sameMat.length === 1 ? sameMat[0] : null;

  return {
    qty: pieces,
    unit: '本',
    perLengthM: chosen.meters,
    totalM,
    stocks: stocks.map((s) => s.meters),
    cost: only ? (typeof only.item.cost === 'number' ? only.item.cost : null) : null,
    name: only ? only.item.name : null,
    why: only ? ''
      : !wantMat ? '材質が分からないので単価は入れていません'
        : sameMat.length ? '肉厚が決まらないので単価は入れていません'
          : `単価マスターに ${wantMat} のこの呼び径がありません`,
  };
}

// ============================================================
// AIが返した項目に、定尺と本数を入れて返す
// 受付（Functions）ではなくアプリ側でやる。単価マスターはアプリが持っているため
//（受付は Firestore を読めない。2026/8/8 に PERMISSION_DENIED で確認済み）。
// ============================================================
export function applyMaterialCounts(items, master) {
  let counted = 0;      // 本数に直せた材料
  let unresolved = 0;   // 総量のままにした材料
  const out = (items || []).map((it) => {
    if (it.kind !== '材料') return it;
    const r = resolveMaterial(master, it);
    if (r.perLengthM) counted += 1;
    else if (isLengthUnit(it.totalUnit)) unresolved += 1;
    return {
      ...it,
      qty: r.qty,
      unit: r.unit,
      // 定尺と総量は残す。あとから「何mぶんの15本か」を画面に出すため
      perLengthM: r.perLengthM,
      totalM: r.totalM,
      stockOptions: r.stocks,
      // 単価が引けたときだけ入る。引けなければ null＝単価待ち（0にしない）
      cost: r.cost,
      // マスターの正式な品名が分かったときは、そちらを正にする
      name: r.name || it.name,
      matWhy: r.why || '',
    };
  });
  return { items: out, counted, unresolved };
}
