// ============================================================
// 概算見積の計算 — 項目 → 費目 → 率 → 合計・提出価格の幅
//
// 本見積（calc.js）との関係:
//   ・率の掛け方と丸め方は calc.js と同じ。移動費と excelRound はそのまま流用する
//   ・違うのは「1項目が3つの金額を持ちうる」こと
//        よつばの単価（自社の原価。率を掛ける）
//        世の中の相場（AIが出した売値。率は掛けない）
//        人が直した金額（売値。率は掛けない）
//   ・人が押すまで合計に入らない（state が '確定' の項目だけ）
//
// 【計算式の正はどこか】… 2026-08-06 決定
//   Excel内訳書と本見積 calc.js が正。**UIモックの数字から計算式を導かないこと。**
//   モックに入っている金額は見本用で、意図的に計算を合わせていない。
//   例: 写真から見積.dc.html のPC版は諸経費を「材料＋労務＋移動＋外注」で
//   出しているように見えるが（936,500×15%＝140,475）、これは見本の数字であって
//   仕様ではない。諸経費・損料のベースは calc.js と同じ「材料費＋労務費」だけ。
//   別ベースに切り替える口は用意しない（間違った金額を出せる経路を残さないため）。
// ============================================================

import { excelRound, travelLine } from './calc.js?v=33';

// 概算に必ず入る定型文（消せない）。AI見積_仕様と準備メモ 第1部より
export const DISCLAIMER =
  '本見積りは現状確認による概算価格です。分解点検後、シャフト、ギヤ、スプロケット、' +
  'カップリング等に交換を要する損傷が確認された場合は、別途協議とします。';

// 工事の種類（AIへの聞き方がこれで切り替わる）
export const WORK_TYPES = ['修理・整備', '製作もの', '配管工事'];

export const ITEM_KINDS = ['材料', '労務', '移動', '外注'];

// 項目の状態。'確定' のものだけが合計に入る
export const ITEM_STATES = ['未確定', '確定', '単価待ち'];

// どの金額を採ったか
export const PRICE_SOURCES = ['yotsuba', 'market', 'manual'];

export const DEFAULT_ROUGH_OPTIONS = {
  welfareOn: true,
  // 提出価格の幅の丸め単位
  bandRoundTo: 10000,
  // 上限に掛ける倍率。概算は必ず幅で出す（2026-08-06 決定）
  //   下限 = 合計を1万円単位に切り下げ
  //   上限 = 合計 × 1.1 を1万円単位に切り上げ
  //   根拠: 社長が実際に出した見積が同じ形だった（税込148.5万に対し「税別135万〜150万」）。
  //   全項目を押し終わっても幅は消えない。未確定が残っているあいだは
  //   その不確かさぶんだけ下限が下がり上限が上がる ＝ 決めるほど幅が狭くなる。
  bandUplift: 1.1,
};

const has = (v) => typeof v === 'number' && isFinite(v);

// ---------- 職種の1h単価 ----------
// unitRates.trades = [{name:'現場工事', rate:4000}, ...]
export function tradeRate(unitRates, tradeName) {
  const t = (unitRates?.trades || []).find((x) => x.name === tradeName);
  return t && has(t.rate) ? t.rate : null;
}

// ---------- 率と単価の3段階 ----------
// 会社の標準 → 元請けごと → この見積だけ、の順に上書き。
// 書いていないところは上の段をそのまま使う（CLAUDE.md「率と単価の3段階」）。
export function resolveRates(company, byCustomer, byEstimate) {
  return { ...(company || {}), ...(byCustomer || {}), ...(byEstimate || {}) };
}

// trades は名前をキーに1件ずつ上書きする（下の段に無い職種は上の段が残る）
export function resolveUnitRates(company, byCustomer, byEstimate) {
  const merged = { ...(company || {}), ...(byCustomer || {}), ...(byEstimate || {}) };
  const byName = new Map();
  for (const src of [company, byCustomer, byEstimate]) {
    for (const t of (src?.trades || [])) {
      if (t && t.name) byName.set(t.name, { ...(byName.get(t.name) || {}), ...t });
    }
  }
  merged.trades = [...byName.values()];
  return merged;
}

// ---------- 手順（項目のくわしい中身） ----------
// step = {name, trade, persons, hours, enabled}
// 「使わない」を押した手順は enabled:false。金額から外れるが行は消さない。
export function stepAmount(step, unitRates) {
  if (!step || step.enabled === false) return 0;
  const rate = has(step.rate) ? step.rate : tradeRate(unitRates, step.trade);
  if (!has(step.persons) || !has(step.hours) || !has(rate)) return 0;
  return step.persons * step.hours * rate;
}

export function stepsTotal(steps, unitRates) {
  return (steps || []).reduce((a, s) => a + stepAmount(s, unitRates), 0);
}

// 人時（モックの「合計 16h」は 2人×8h ＝ 16人時）
export function stepsManHours(steps) {
  return (steps || [])
    .filter((s) => s.enabled !== false)
    .reduce((a, s) => a + (has(s.persons) && has(s.hours) ? s.persons * s.hours : 0), 0);
}

const usableSteps = (item) => (item.steps || []).some((s) => s.enabled !== false);

// ---------- よつばの単価（自社の原価。率はまだ掛けない） ----------
// 手順があるときは手順が正。「ざっくり」の人数×時間は手順を出した時点で同じ値になる。
export function yotsubaBase(item, unitRates) {
  switch (item.kind) {
    case '材料':
      return has(item.qty) && has(item.cost) ? item.qty * item.cost : null;
    case '労務': {
      if (usableSteps(item)) return stepsTotal(item.steps, unitRates);
      const rate = has(item.rate) ? item.rate : tradeRate(unitRates, item.trade);
      if (!has(item.persons) || !has(item.hours) || !has(rate)) return null;
      return item.persons * item.hours * rate;
    }
    case '移動':
      return travelLine(item, unitRates).amount;
    case '外注':
      // 本見積の明細（screen-material.js）と同じく外注は amount に金額を持つ
      return has(item.amount) ? item.amount : null;
    default:
      return null;
  }
}

// よつばの単価に率を掛けた「計上金額」
export function yotsubaAmount(item, rates, unitRates) {
  const base = yotsubaBase(item, unitRates);
  if (!has(base)) return null;
  if (item.kind === '材料') return base * (1 + (rates.material || 0));
  if (item.kind === '労務') return base * (1 + (rates.labor || 0));
  return base; // 移動・外注は上乗せなし（calc.js と同じ）
}

// 世の中の相場・人が直した金額は「売値」なので率を掛けない
export function marketAmount(item) {
  return has(item.marketAmount) ? item.marketAmount : null;
}

export function manualAmount(item) {
  return has(item.manualAmount) ? item.manualAmount : null;
}

// 押せる選択肢のうち、実際に金額が出せるものだけ返す
export function itemCandidates(item, rates, unitRates) {
  const out = [];
  const y = yotsubaAmount(item, rates, unitRates);
  if (has(y)) out.push({ source: 'yotsuba', amount: y });
  const m = marketAmount(item);
  if (has(m)) out.push({ source: 'market', amount: m });
  const h = manualAmount(item);
  if (has(h)) out.push({ source: 'manual', amount: h });
  return out;
}

// ---------- 合計に入る金額 ----------
// 人が押すまで（state が '確定' になるまで）null。ここが仕様の芯。
export function itemAmount(item, rates, unitRates) {
  if (item.state !== '確定') return null;
  switch (item.chosen) {
    case 'market': return marketAmount(item);
    case 'manual': return manualAmount(item);
    case 'yotsuba': return yotsubaAmount(item, rates, unitRates);
    default: {
      // chosen が無い確定は、よつばの単価があればそれ、無ければ相場を採る
      const c = itemCandidates(item, rates, unitRates);
      return c.length ? c[0].amount : null;
    }
  }
}

// ---------- 提出価格の幅 ----------
// 確定    … その金額でぴたり
// 未確定  … 出ている候補の 最小 〜 最大
// 単価待ち… 下は0（まだ入れない）／上は相場が分かっていればそれ、無ければ0
//           ※ 金額が全く分からない単価待ちは幅に出ない。件数で見せる
export function itemRange(item, rates, unitRates) {
  if (item.state === '確定') {
    const a = itemAmount(item, rates, unitRates);
    return has(a) ? { low: a, high: a } : { low: 0, high: 0 };
  }
  if (item.state === '単価待ち') {
    const m = marketAmount(item) ?? yotsubaAmount(item, rates, unitRates);
    return { low: 0, high: has(m) ? m : 0 };
  }
  const amounts = itemCandidates(item, rates, unitRates).map((c) => c.amount);
  if (!amounts.length) return { low: 0, high: 0 };
  return { low: Math.min(...amounts), high: Math.max(...amounts) };
}

// mode: 'final' 合計に入る金額 / 'low' 幅の下 / 'high' 幅の上
function amountFor(item, rates, unitRates, mode) {
  if (mode === 'final') return itemAmount(item, rates, unitRates) || 0;
  return itemRange(item, rates, unitRates)[mode] || 0;
}

// ---------- 費目ごとの合計 ----------
export function sumByKind(items, rates, unitRates, mode = 'final') {
  const out = { 材料: 0, 労務: 0, 移動: 0, 外注: 0 };
  for (const it of items || []) {
    if (!ITEM_KINDS.includes(it.kind)) continue;
    out[it.kind] += amountFor(it, rates, unitRates, mode);
  }
  return out;
}

// ---------- 費目 → 税込までの集計 ----------
// 返す形は calc.js の totals() と揃えてある（画面とCSVで同じ扱いができるように）
export function totalsFromKinds(kinds, rates, opts = {}) {
  const o = { ...DEFAULT_ROUGH_OPTIONS, ...opts };
  const material = kinds.材料 || 0;
  const labor = kinds.労務 || 0;
  const travel = kinds.移動 || 0;
  const subcontract = kinds.外注 || 0;

  // 諸経費・損料のベースは材料費＋労務費だけ（calc.js の totals() と同じ）。
  // 移動費と外注費は入らない。
  const spreadBase = material + labor;

  const overhead = excelRound(spreadBase * (rates.overhead || 0));
  const welfare = o.welfareOn ? excelRound(labor * (rates.welfare || 0)) : 0;
  const depreciation = excelRound(spreadBase * (rates.depreciation || 0));

  const taxable = material + labor + travel + subcontract + overhead + welfare + depreciation;
  const tax = excelRound(taxable * (rates.tax || 0));
  const withTax = taxable + tax;

  return {
    material, labor, travel, subcontract,
    overhead, welfare, depreciation,
    spreadBase, taxable, tax, withTax,
  };
}

export function roughTotals(items, rates, unitRates, opts = {}) {
  return totalsFromKinds(sumByKind(items, rates, unitRates, 'final'), rates, opts);
}

// ---------- 件数（画面の帯に出す） ----------
export function counts(items) {
  const list = items || [];
  return {
    items: list.length,
    decided: list.filter((i) => i.state === '確定').length,
    undecided: list.filter((i) => i.state === '未確定').length,
    pending: list.filter((i) => i.state === '単価待ち').length,
  };
}

const floorTo = (n, unit) => Math.floor(n / unit) * unit;
const ceilTo = (n, unit) => Math.ceil(n / unit) * unit;

// 提出価格の目安（税込）。概算は必ず幅で出す。
//   下限 = 合計を1万円単位に切り下げ
//   上限 = 合計 × 1.1 を1万円単位に切り上げ
// 未確定の項目があるあいだは rawLow < rawHigh になり、その不確かさぶんだけ
// 幅が両側に広がる。押して決めるほど rawLow と rawHigh が寄り、幅が狭くなる。
export function priceBand(items, rates, unitRates, opts = {}) {
  const o = { ...DEFAULT_ROUGH_OPTIONS, ...opts };
  const rawLow = totalsFromKinds(sumByKind(items, rates, unitRates, 'low'), rates, o).withTax;
  const rawHigh = totalsFromKinds(sumByKind(items, rates, unitRates, 'high'), rates, o).withTax;
  const uplift = has(o.bandUplift) ? o.bandUplift : 1;
  const low = rawLow;
  const high = rawHigh * uplift;
  const unit = o.bandRoundTo > 0 ? o.bandRoundTo : 1;
  const c = counts(items);
  return {
    low, high, rawLow, rawHigh,
    displayLow: floorTo(low, unit),
    displayHigh: ceilTo(high, unit),
    // まだ何も金額が出ていないときは画面が「￥— 〜 ￥—」を出す
    hasAmount: high > 0,
    ...c,
  };
}

// ---------- 項目1件の内訳（画面2「この項目にかかるもの」） ----------
// 諸経費は項目単位では出さない（全体でしか按分できないため）。
// 労務費 ＋ 損料5% ＋ 法定福利費16%（労務費のみ） ＝ この項目（税抜）
// 損料は材料費・労務費の行にだけかかる。移動費・外注費の行にはかからない。
export function itemBreakdown(item, rates, unitRates, opts = {}) {
  const o = { ...DEFAULT_ROUGH_OPTIONS, ...opts };
  const amount = itemAmount(item, rates, unitRates) ?? yotsubaAmount(item, rates, unitRates) ?? 0;
  const isLabor = item.kind === '労務';
  const isMaterial = item.kind === '材料';
  const spreadBase = isLabor || isMaterial ? amount : 0;

  const depreciation = excelRound(spreadBase * (rates.depreciation || 0));
  const welfare = o.welfareOn && isLabor ? excelRound(amount * (rates.welfare || 0)) : 0;

  return {
    amount,
    kind: item.kind,
    depreciation,
    welfare,
    taxable: amount + depreciation + welfare,
    manHours: isLabor && usableSteps(item)
      ? stepsManHours(item.steps)
      : (has(item.persons) && has(item.hours) ? item.persons * item.hours : null),
  };
}
