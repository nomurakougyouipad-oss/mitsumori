// ============================================================
// 集計表を読み込む — 事務員さんの「納品書 材料集計表」から単価マスターを育てる
// 列: A注番 B日付 C番号 D名称 E材質 F形格 G数量 H単位 I単位重量 J重量 K単価 L金額 M備考
// ・J重量が入っていれば K はkg単価、無ければ個/本単価（L列の数式と同じ判定）
// ・別名辞書: 一度つないだ表記は items.aliases[] に記録され、次からは自動
// ・穴は指摘するだけで、止めない
// ============================================================

import { esc, YEN, fmtDate } from './util.js?v=2';
import { openOverlay, toast } from './ui.js?v=2';
import { cache, norm } from './store.js?v=2';
import {
  db, doc, collection, addDoc, updateDoc, Timestamp, serverTimestamp, arrayUnion,
} from './firebase.js?v=2';

// SheetJSを必要なときだけCDNから読む（事務所PCはオンライン前提）
let sheetJs = null;
function loadSheetJs() {
  if (sheetJs) return sheetJs;
  sheetJs = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = () => res(window.XLSX);
    s.onerror = () => rej(new Error('SheetJSを読み込めませんでした（電波を確認）'));
    document.head.appendChild(s);
  });
  return sheetJs;
}

const aliasKey = (d, e, f) => [d, e, f].map((x) => String(x || '').trim()).join('｜');

function knownPrefixes() {
  const set = new Set();
  for (const s of cache.standingOrders) { const m = (s.orderNo || '').match(/^([A-Z]{2})/); if (m) set.add(m[1]); }
  for (const e of cache.estimates) { const m = (e.orderNo || '').match(/^([A-Z]{2})/); if (m) set.add(m[1]); }
  return set;
}

// 行 → マスター突き合わせ
// 名称・材質・形格を「原子」（語と数値）に分解して照合する。
// 寸法は 5500 ↔ 5.5m のような単位ゆれも吸収。
// 自動: 別名辞書に一致、または 数値がすべて一致＋語が1つ以上一致
const atomize = (s) => norm(s).replace(/[()（）\-＝=]/g, ' ').split(/[\sx×,]+/).filter((a) => a.length > 0);
function atomHit(key, a) {
  if (key.includes(a)) return true;
  if (/^\d+$/.test(a)) {
    const n = parseInt(a, 10);
    if (n >= 1000 && n % 100 === 0 && (key.includes((n / 1000) + 'm') || key.includes((n / 1000) + '.0m'))) return true;
  }
  return false;
}
// 加工品らしい行（一点物。マスターには登録しない前提で仕分けを促す）
const looksFab = (row) => /型切|角切|穴明|レーザー|ﾚｰｻﾞｰ|加工/.test(row.name + row.spec);

function matchRow(row) {
  const ak = aliasKey(row.name, row.material, row.spec);
  const exact = cache.items.find((it) => (it.aliases || []).includes(ak));
  if (exact) return { kind: 'auto', item: exact, viaAlias: true };
  const atoms = atomize([row.name, row.material, row.spec].join(' '));
  if (!atoms.length) return { kind: 'none', candidates: [] };
  const nums = atoms.filter((a) => /\d/.test(a));
  const words = atoms.filter((a) => !/\d/.test(a));
  const scored = [];
  let autoItem = null;
  for (const it of cache.items) {
    let nHit = 0, wHit = 0;
    for (const a of nums) if (atomHit(it.searchKey, a)) nHit++;
    for (const a of words) if (it.searchKey.includes(a)) wHit++;
    const score = (nHit + wHit) / atoms.length;
    if (score >= 0.5) scored.push({ it, score });
    if (!looksFab(row) && nums.length >= 2 && nHit === nums.length && wHit >= 1 && !autoItem) autoItem = it;
  }
  if (autoItem) return { kind: 'auto', item: autoItem, viaAlias: false };
  scored.sort((a, b) => b.score - a.score || (b.it.useCount || 0) - (a.it.useCount || 0));
  return { kind: scored.length && !looksFab(row) ? 'cand' : 'none', candidates: scored.slice(0, 3).map((s) => s.it), fabLikely: looksFab(row) };
}

function priceOf(row, item) {
  // kg単価の行はkgPriceと、個/本の行はcostと比べる
  return row.isKg ? { cur: item.kgPrice, kind: 'kg単価' } : { cur: item.cost, kind: '個/本単価' };
}

export function openTallyPage() {
  const ov = openOverlay();
  let rows = null, result = null, applied = false;

  function parseSheet(XLSX, buf) {
    const wb = XLSX.read(buf, { type: 'array', cellDates: false });
    const wsName = wb.SheetNames.find((n) => n.includes('集計')) || wb.SheetNames[0];
    const ws = wb.Sheets[wsName];
    const out = [];
    for (let r = 2; r <= 2000; r++) {
      const v = (c) => { const cell = ws[c + r]; return cell ? cell.v : ''; };
      const name = String(v('D') || '').trim();
      if (!name || name === '名称') continue; // ヘッダー行はスキップ
      out.push({
        r, orderNo: String(v('A') || '').trim(), name,
        material: String(v('E') || '').trim(), spec: String(v('F') || '').trim(),
        qty: v('G'), unit: String(v('H') || '').trim(),
        weight: typeof v('J') === 'number' ? v('J') : null,
        price: typeof v('K') === 'number' ? v('K') : null,
        amount: typeof v('L') === 'number' ? v('L') : null,
        note: String(v('M') || '').trim(),
        isKg: typeof v('J') === 'number' && v('J') > 0,
      });
    }
    return out;
  }

  function analyze() {
    const prefixes = knownPrefixes();
    const supplierNames = new Set(cache.suppliers.flatMap((s) => [s.name, ...(s.aliases || [])]));
    const issues = [];
    const auto = [], cand = [], none = [];
    let noAmount = 0;
    const unknownPrefix = new Set(), unknownSupplier = new Set();
    for (const row of rows) {
      if (row.amount == null) noAmount++;
      const pm = row.orderNo.match(/^([A-Z]{2})/);
      if (pm && !prefixes.has(pm[1])) unknownPrefix.add(pm[1]);
      const sup = row.note.split(/[／/]/)[0].trim();
      row.supplier = sup;
      if (sup && ![...supplierNames].some((n) => sup.startsWith(n) || n.startsWith(sup))) unknownSupplier.add(sup);
      const m = matchRow(row);
      row.match = m;
      if (m.kind === 'auto') auto.push(row);
      else if (m.kind === 'cand') cand.push(row);
      else none.push(row);
    }
    if (noAmount) issues.push(`金額が空の行が${noAmount}件あります`);
    if (unknownPrefix.size) issues.push(`知らない注番のプレフィックス: ${[...unknownPrefix].join('・')}`);
    if (unknownSupplier.size) issues.push(`知らない仕入先: ${[...unknownSupplier].slice(0, 6).join('・')}${unknownSupplier.size > 6 ? ' ほか' : ''}`);
    result = { issues, auto, cand, none };
  }

  // 自動でつながった行をマスターへ反映（同じ→更新日だけ／違う→判断待ち）
  async function applyAuto() {
    let refreshed = 0, reviews = 0;
    for (const row of result.auto) {
      const item = row.match.item;
      const { cur, kind } = priceOf(row, item);
      const ak = aliasKey(row.name, row.material, row.spec);
      try {
        if (!row.match.viaAlias) await updateDoc(doc(db, 'items', item.id), { aliases: arrayUnion(ak) });
        if (row.price == null) continue;
        if (cur != null && Math.abs(cur - row.price) < 0.5) {
          await updateDoc(doc(db, 'items', item.id), { updatedAt: Timestamp.now() });
          refreshed++;
        } else if (cur != null) {
          await addDoc(collection(db, 'priceReviews'), {
            itemId: item.id, name: item.name, currentCost: cur, newCost: row.price,
            unitKind: kind, source: `集計表 ${row.orderNo || ''}`.trim(),
            reason: row.price < cur ? '安くなっている（白か特価の可能性）' : '値上がり',
            status: '判断待ち', createdAt: serverTimestamp(),
          });
          reviews++;
        }
      } catch (e) { console.error(e); }
    }
    applied = true;
    toast(`自動分を反映：更新日そのまま新しく${refreshed}件／判断待ちへ${reviews}件`);
    paint();
  }

  // 候補行の解決（押した対応を別名辞書に覚える）
  async function resolveCand(row, item) {
    const ak = aliasKey(row.name, row.material, row.spec);
    try {
      await updateDoc(doc(db, 'items', item.id), { aliases: arrayUnion(ak) });
      const { cur, kind } = priceOf(row, item);
      if (row.price != null && cur != null && Math.abs(cur - row.price) >= 0.5) {
        await addDoc(collection(db, 'priceReviews'), {
          itemId: item.id, name: item.name, currentCost: cur, newCost: row.price,
          unitKind: kind, source: `集計表 ${row.orderNo || ''}`.trim(),
          reason: row.price < cur ? '安くなっている（白か特価の可能性）' : '値上がり',
          status: '判断待ち', createdAt: serverTimestamp(),
        });
      } else if (row.price != null) {
        await updateDoc(doc(db, 'items', item.id), { updatedAt: Timestamp.now() });
      }
      row.resolved = `→ ${item.name}`;
      toast('つなぎました。次からは自動でつながります');
      paint();
    } catch (e) { console.error(e); toast('保存できませんでした'); }
  }

  async function resolveAsNew(row) {
    try {
      const it = {
        category: '', supplier: row.supplier || '', name: row.name + (row.spec ? ' ' + row.spec : ''),
        unit: row.unit || '', material: row.material || '', spec: row.spec || '', type: '',
        useCount: 0, aliases: [aliasKey(row.name, row.material, row.spec)],
        effectiveDate: null, updatedAt: Timestamp.now(), updatedAtRaw: '', needsReview: true,
      };
      if (row.isKg) { it.kgPrice = row.price; if (row.weight && row.qty) it.weight = row.weight / (row.qty || 1); }
      if (row.price != null && !row.isKg) it.cost = row.price;
      await addDoc(collection(db, 'items'), it);
      row.resolved = '→ 新規追加（要確認つき）';
      toast('新規材料として追加しました');
      paint();
    } catch (e) { console.error(e); toast('保存できませんでした'); }
  }

  function skip(row, label) { row.resolved = label; paint(); }

  function paint() {
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar"><button class="icon-btn" id="t-back">←</button><span class="ttl">集計表を読み込む</span></div></div>
      <div class="page-body"><div style="padding:12px">
        ${!rows ? `
          <div class="card">納品書 材料集計表（.xlsx）を選んでください。<b>アプリは読むだけで、集計表には書き込みません。</b>
            <div style="margin-top:10px"><input type="file" id="t-file" accept=".xlsx,.xlsm"></div></div>`
        : `
          <div class="card">
            <div class="ttl" style="font-size:14px">読み取り ${rows.length}行</div>
            <div class="meta">自動でつながった ${result.auto.length} ／ 候補あり ${result.cand.length} ／ 見つからない ${result.none.length}</div>
            ${result.issues.length ? `<div style="margin-top:8px;font-size:12.5px;color:#8A560F;line-height:1.7">⚠ ${result.issues.map(esc).join('<br>⚠ ')}<br><span style="color:var(--muted2)">（指摘するだけで、止めません）</span></div>` : ''}
            ${!applied ? `<button class="btn btn-primary btn-block" style="margin-top:10px" id="t-apply">自動分をマスターへ反映（${result.auto.length}件）</button>` : '<div style="margin-top:8px;font-size:13px;color:var(--green);font-weight:700">✓ 自動分は反映済み</div>'}
          </div>
          ${[...result.cand, ...result.none].map((row, i) => `
            <div class="card" style="margin-top:8px">
              <div class="ttl" style="font-size:14px">${esc(row.name)}</div>
              <div class="meta">${esc([row.material, row.spec].filter(Boolean).join(' ／ '))}　${row.price != null ? `<b class="num">${YEN(row.price)}</b>／${row.isKg ? 'kg' : esc(row.unit || '個')}` : '単価なし'}　<span class="num">${esc(row.orderNo)}</span></div>
              ${row.resolved ? `<div style="font-size:13px;color:var(--green);font-weight:700;margin-top:6px">✓ ${esc(row.resolved)}</div>` : `
                <div style="font-size:12px;font-weight:700;color:var(--muted);margin-top:8px">これですか?</div>
                <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
                  ${(row.match.candidates || []).map((c, ci) => `<button class="btn btn-sm" style="justify-content:flex-start" data-pick="${i}|${ci}">${esc(c.name)}（${c.cost != null ? YEN(c.cost) : '—'}）</button>`).join('')}
                  <div style="display:flex;gap:6px;flex-wrap:wrap">
                    <button class="btn btn-sm" data-new="${i}">マスターに無い→新規</button>
                    <button class="btn btn-sm" data-skip1="${i}">加工品・購入品（登録しない）</button>
                    <button class="btn btn-sm" data-skip2="${i}">工具・消耗品（対象外）</button>
                  </div>
                </div>`}
            </div>`).join('')}
        `}
      </div></div>`;

    ov.el.querySelector('#t-back').addEventListener('click', ov.close);
    ov.el.querySelector('#t-file')?.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const XLSX = await loadSheetJs();
        rows = parseSheet(XLSX, await f.arrayBuffer());
        analyze();
        paint();
      } catch (err) { console.error(err); toast(String(err.message || err)); }
    });
    ov.el.querySelector('#t-apply')?.addEventListener('click', applyAuto);
    const pend = [...result?.cand || [], ...result?.none || []];
    ov.el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      const [i, ci] = b.dataset.pick.split('|').map(Number);
      resolveCand(pend[i], pend[i].match.candidates[ci]);
    }));
    ov.el.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => resolveAsNew(pend[+b.dataset.new])));
    ov.el.querySelectorAll('[data-skip1]').forEach((b) => b.addEventListener('click', () => skip(pend[+b.dataset.skip1], '加工品・購入品（登録しない）')));
    ov.el.querySelectorAll('[data-skip2]').forEach((b) => b.addEventListener('click', () => skip(pend[+b.dataset.skip2], '工具・消耗品（対象外・zaiko-shohinの領域）')));
  }

  paint();
}
