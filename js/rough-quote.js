// ============================================================
// 概算見積の文面を組み立てる
//
// 出どころは 参考/概算見積.html の makeOut()。並びと言い回しはそのまま。
// 金額は必ず rough-calc.js から受け取る（ここでは計算しない）。
//
// 【単価待ちは隠さない】合計に入っていない項目があることを、文面にも書く。
//   モックの帯にある通り「追って連絡」と入れる。
//   黙って落とすと、あとで金額が増えたときに説明できなくなる。
//
// 【見積条件は消せない】DISCLAIMER を必ず入れる。
// ============================================================

import { DISCLAIMER, itemAmount } from './rough-calc.js?v=33';

// 会社の連絡先。変わったらここだけ直す
export const COMPANY = {
  name: '株式会社よつば建設工業',
  zip: '〒791-3131',
  address: '愛媛県伊予郡松前町大字北河原1142番地1',
  tel: 'TEL 089-994-5162',
  fax: 'FAX 089-994-5163',
};

const yen = (n) => '￥' + Math.round(n || 0).toLocaleString('ja-JP');

// 「2026年8月6日」
export function jaDate(d) {
  const x = d instanceof Date ? d : new Date();
  return `${x.getFullYear()}年${x.getMonth() + 1}月${x.getDate()}日`;
}

export function subjectOf(rough) {
  return `【概算御見積】${rough?.projectName || '工事'}`;
}

export function addressOf(rough) {
  const c = (rough?.customer || '').trim();
  if (!c) return '';
  // すでに敬称が付いていれば足さない
  return /(御中|様|殿)$/.test(c) ? c : c + ' 御中';
}

// ---------- 本文 ----------
// items は画面が持っているものをそのまま渡す。金額は rates/unitRates から出す。
export function buildQuoteText(rough, items, totals, band, rates, unitRates, opts = {}) {
  const today = opts.today instanceof Date ? opts.today : new Date();
  const L = [];
  const push = (s = '') => L.push(s);

  push('概　算　御　見　積　書');
  push();
  const to = addressOf(rough);
  if (to) push(to);
  push(`工事名：${rough?.projectName || '（未入力）'}`);
  if (rough?.site) push(`施工場所：${rough.site}`);
  push(`作成日：${jaDate(today)}`);
  push();
  push('下記の通り概算にて御見積申し上げます。');
  push();

  push('― 項目 ―');
  const pending = [];
  for (const it of items || []) {
    const name = (it.name || '').trim();
    if (!name) continue;
    if (it.state === '単価待ち') { pending.push(name); push(`・${name}　… 単価確認中`); continue; }
    if (it.state !== '確定') continue;              // 未確定は合計に入っていないので出さない
    if (it.kind === '移動') continue;               // 現場移動費は下でまとめて1行にする
    const a = itemAmount(it, rates, unitRates);
    push(`・${name}　${yen(a)}`);
  }
  if (totals.travel) push(`・現場移動費　${yen(totals.travel)}`);
  push();

  push(`諸経費　${yen(totals.overhead)}`);
  if (totals.welfare) push(`法定福利費　${yen(totals.welfare)}`);
  push(`損料　${yen(totals.depreciation)}`);
  push(`税抜計　${yen(totals.taxable)}`);
  push(`消費税　${yen(totals.tax)}`);
  push(`税込合計　${yen(totals.withTax)}`);
  push();
  push(`御見積金額（税込）　${yen(band.displayLow)} 〜 ${yen(band.displayHigh)}`);
  push();

  push('― 見積条件 ―');
  push(DISCLAIMER);
  if (pending.length) {
    push();
    push(`※ 次の項目は単価確認中のため、上記金額に含まれておりません。追って連絡いたします。`);
    push(`　 ${pending.join('、')}`);
  }
  push();
  push(COMPANY.name);
  push(`${COMPANY.zip} ${COMPANY.address}`);
  push(`${COMPANY.tel} ／ ${COMPANY.fax}`);

  return L.join('\n');
}

// 単価待ちの件数（画面の帯に出す）
export function pendingNames(items) {
  return (items || []).filter((i) => i.state === '単価待ち' && (i.name || '').trim()).map((i) => i.name);
}
