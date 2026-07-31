// ============================================================
// Excelへの受け渡し — CSV書き出し（README第5章）
// アプリはxlsmを作らない。Excel側マクロ「アプリのCSVを読み込む」が
// このCSVを内訳書のセルに書き込む。ファイルは excel/ImportCSV.bas。
//
// 率の書き方（ここを間違えると金額が丸ごとずれる）:
//   材料 B12・労務 C12 だけ「1＋率」（15%→1.15）
//   諸経費D12・福利E12・消費税F12・売上目標G12・損料H12 はそのまま（0.15など）
//   法定福利費オフの見積は E12=0 で渡す（Excel側が0円で計算するように）
// ============================================================

import { downloadCsv } from './util.js?v=8';
import { lineAmount } from './calc.js?v=8';

// Excel内訳書の行数の上限
const LIMITS = { 材料: 15, 労務: 10, 移動: 7, 外注: 7 };

export function buildCsvRows(est, lines, rates, unitRates) {
  const rows = [];
  const warnings = [];
  rows.push(['FORMAT', 'mitsumori-v1']);
  rows.push(['C5', est.projectName || '']);
  rows.push(['C6', est.site || '']);
  rows.push(['C8', est.customer || '']);
  rows.push(['C9', est.orderNo || '']);
  rows.push(['STAFF', est.staff || '']);

  rows.push(['B12', 1 + (rates.material || 0)]);   // 材料は「1＋」
  rows.push(['C12', 1 + (rates.labor || 0)]);      // 労務は「1＋」
  rows.push(['D12', rates.overhead || 0]);
  rows.push(['E12', est.welfareOn !== false ? (rates.welfare || 0) : 0]);
  rows.push(['F12', rates.tax || 0]);
  rows.push(['G12', rates.targetMargin || 0]);
  rows.push(['H12', rates.depreciation || 0]);

  const byKind = (k) => lines.filter((l) => l.kind === k);
  for (const [k, limit] of Object.entries(LIMITS)) {
    const ls = byKind(k);
    if (ls.length > limit) warnings.push(`${k}が${ls.length}行あります（Excelは${limit}行まで。超えた分は入りません）`);
  }

  for (const l of byKind('材料').slice(0, LIMITS.材料)) {
    // B品名 C数量 H計上金額 L仕入先（金額は丸めず渡す。Excel側の合計と一致させる）
    const amount = lineAmount(l, rates, unitRates);
    rows.push(['MAT', l.name || '', l.qty ?? '', amount ?? 0, l.supplier || '']);
  }
  for (const l of byKind('労務').slice(0, LIMITS.労務)) {
    rows.push(['LAB', l.trade || l.name || '', l.persons ?? '', l.hours ?? '']);
  }
  for (const l of byKind('移動').slice(0, LIMITS.移動)) {
    // B作業内容 C人数 D時間 F距離（E移動1h単価・G km単価はExcel側の自動セル）
    rows.push(['TRV', l.name || '現場移動', l.persons ?? '', l.hours ?? '', l.km ?? '']);
  }
  for (const l of byKind('外注').slice(0, LIMITS.外注)) {
    rows.push(['SUB', l.supplier || '', l.name || '', l.amount ?? 0]);
  }

  rows.push(['H85', est.adjust || 0]);
  return { rows, warnings };
}

export function exportEstimateCsv(est, lines, rates, unitRates, { approx = false } = {}) {
  const { rows, warnings } = buildCsvRows(est, lines, rates, unitRates);
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const base = (est.orderNo || est.projectName || 'mitsumori').replace(/[\\/:*?"<>|]/g, '_');
  const name = `mitsumori_${base}_${stamp}${approx ? '_概算' : ''}.csv`;
  downloadCsv(name, rows);
  return warnings;
}
