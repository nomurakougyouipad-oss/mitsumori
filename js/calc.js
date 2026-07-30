// ============================================================
// 計算エンジン — Excel内訳書と1円まで一致させる（README第3章）
// 実際のExcel式（2026-07-30に原本から抽出）に準拠:
//   材料行  F = 数量×原価            H = F×(1+材料%)      ※丸めなし
//   労務行  F = 人数×時間×1h単価     H = F×(1+労務%)      ※丸めなし
//   移動行  H = ROUND(人数×時間×移動1h単価,0)
//            + 距離があれば ROUND(距離×2×km単価,0)        ※往復で×2
//            ※人数・時間が無い行は距離だけあっても0（Excelと同じ）
//   外注行  H = 手入力の金額
//   小計   = 単純合計（丸めなし。端数はそのまま持ち回る）
//   諸経費 = ROUND((材+労)×諸経費%,0)   ※計上ベース。移動費・外注費は入らない
//   福利   = ROUND(労×福利%,0)          ※オフなら0
//   損料   = ROUND((材+労)×損料%,0)
//   税抜   = 材+労+移+外+諸+福+損
//   消費税 = ROUND(税抜×税%,0)
//   税込   = 税抜+消費税
//   御見積金額 = 税込+端数調整（手入力・マイナス可）
//   売上目標逆算 = ROUND(税抜÷(1−目標%),0)  ※参考表示のみ
// 丸め以外の途中の丸め直しは絶対に追加しないこと。
// ============================================================

// ExcelのROUND(x,0): 四捨五入（負数は絶対値で丸める＝0から遠ざける）
// JSのMath.roundは-0.5→-0になるため使わない
export function excelRound(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

const has = (v) => typeof v === 'number' && isFinite(v);

// ---- 行の金額（kindごと） ----

// 材料行: {qty, cost} → {base: 原価計, amount: 計上金額}
export function materialLine(line, rates) {
  if (!has(line.qty) || !has(line.cost)) return { base: null, amount: null };
  const base = line.qty * line.cost;
  return { base, amount: base * (1 + rates.material) };
}

// 労務行: {persons, hours, rate(1h単価)} → {base, amount}
export function laborLine(line, rates) {
  if (!has(line.persons) || !has(line.hours) || !has(line.rate)) return { base: null, amount: null };
  const base = line.persons * line.hours * line.rate;
  return { base, amount: base * (1 + rates.labor) };
}

// 移動行: {persons, hours, km} + unitRates{travelLabor, kmRate} → {amount}
// Excel H53: IF(AND(人数,時間), ROUND(人数*時間*単価,0) + IF(距離, ROUND(距離*2*km単価,0), 0), "")
export function travelLine(line, unitRates) {
  if (!has(line.persons) || !has(line.hours)) return { amount: null };
  let amount = excelRound(line.persons * line.hours * unitRates.travelLabor);
  if (has(line.km)) amount += excelRound(line.km * 2 * unitRates.kmRate);
  return { amount };
}

// 外注行: {amount} 手入力そのまま
export function subcontractLine(line) {
  return { amount: has(line.amount) ? line.amount : null };
}

// ---- 明細行の配列 → 行金額 ----
// line: {kind:'材料'|'労務'|'移動'|'外注', ...}
export function lineAmount(line, rates, unitRates) {
  switch (line.kind) {
    case '材料': return materialLine(line, rates).amount;
    case '労務': return laborLine(line, rates).amount;
    case '移動': return travelLine(line, unitRates).amount;
    case '外注': return subcontractLine(line).amount;
    default: return null;
  }
}

// ---- 見積全体の集計 ----
// lines: 明細行の配列 / rates: 率(小数) / unitRates: {travelLabor, kmRate}
// welfareOn: 法定福利費のオン/オフ / adjust: 端数調整(整数・マイナス可)
export function totals(lines, rates, unitRates, welfareOn, adjust = 0) {
  const sum = (kind) => lines
    .filter((l) => l.kind === kind)
    .reduce((acc, l) => acc + (lineAmount(l, rates, unitRates) || 0), 0);

  const material = sum('材料');          // … H35
  const labor = sum('労務');             // … H49
  const travel = sum('移動');            // … H60
  const subcontract = sum('外注');       // … H70

  const overhead = excelRound((material + labor) * rates.overhead);            // … H74
  const welfare = welfareOn ? excelRound(labor * rates.welfare) : 0;           // … H77
  const depreciation = excelRound((material + labor) * rates.depreciation);    // … H80

  const taxable = material + labor + travel + subcontract + overhead + welfare + depreciation; // … H82
  const tax = excelRound(taxable * rates.tax);                                 // … H83
  const withTax = taxable + tax;                                               // … H84
  const final = withTax + (has(adjust) ? adjust : 0);                          // … H86
  const targetPrice = rates.targetMargin < 1
    ? excelRound(taxable / (1 - rates.targetMargin))                           // … H87
    : null;

  return {
    material, labor, travel, subcontract,
    overhead, welfare, depreciation,
    taxable, tax, withTax, adjust: has(adjust) ? adjust : 0, final, targetPrice,
  };
}

// 既定の率（settings/rates が読めないときの保険。値はExcel原本と同じ）
export const DEFAULT_RATES = {
  material: 0.15, labor: 0, overhead: 0.15,
  welfare: 0.16, depreciation: 0.05, tax: 0.10, targetMargin: 0.25,
};

export const DEFAULT_UNIT_RATES = { travelLabor: 3000, kmRate: 25 };
