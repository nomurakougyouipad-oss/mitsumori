// ============================================================
// 集計表を読み込む — 事務員さんの「納品書 材料集計表」から単価マスターを育てる
// 列: A注番 B日付 C番号 D名称 E材質 F形格 G数量 H単位 I単位重量 J重量 K単価 L金額 M備考
// ・J重量が入っていれば K はkg単価、無ければ個/本単価（L列の数式と同じ判定）
// ・別名辞書: 一度つないだ表記は items.aliases[] に記録され、次からは自動
// ・穴は指摘するだけで、止めない
// ============================================================

import { esc, YEN, fmtDate } from './util.js?v=26';
import { openOverlay, toast } from './ui.js?v=26';
import { cache, norm } from './store.js?v=26';
import {
  db, doc, collection, addDoc, updateDoc, Timestamp, serverTimestamp, arrayUnion,
} from './firebase.js?v=26';

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

export const aliasKey = (d, e, f) => [d, e, f].map((x) => String(x || '').trim()).join('｜');

function knownPrefixes() {
  const set = new Set();
  for (const s of cache.standingOrders) { const m = (s.orderNo || '').match(/^([A-Z]{2})/); if (m) set.add(m[1]); }
  for (const e of cache.estimates) { const m = (e.orderNo || '').match(/^([A-Z]{2})/); if (m) set.add(m[1]); }
  return set;
}

// 行 → マスター突き合わせ
// 名称・材質・形格を「原子」（語と数値）に分解して照合する。
// 寸法は 5500 ↔ 5.5m のような単位ゆれも吸収。
// 数値は境界つきで照合する（「25A」が「125A」に部分一致しないように）。
// 自動: 別名辞書に一致、または 数値がすべて一致＋語が1つ以上一致（最良スコアの品目を採用）
// アトムの正規化: よくある表記ゆれを1つの形に寄せる
//  ・「90度」→「90°」、「90°32A」→「90°」「32A」（°の後で切る）
//  ・「カバー1」のような 日本語+数字 の癒着も切る
//  ・板厚 t1 ↔ 1t、ワッシャー 2FW ↔ PW2 ↔ FW2（平W2枚の意）
const canonAtom = (a) => {
  a = a.replace(/^t(\d+(?:\.\d+)?)$/, '$1t');
  a = a.replace(/^(\d+)\.0+$/, '$1').replace(/^(\d+\.\d*[1-9])0+$/, '$1'); // 5.00→5, 1000.0→1000
  if (a === '2fw' || a === 'pw2' || a === '2pw') return 'fw2';
  if (a === 'pw') return 'fw';
  return a;
};
export const atomize = (s) => norm(s)
  .replace(/[()（）\-＝=・、。／/【】｜]/g, ' ')
  .replace(/(\d)度/g, '$1°')
  .replace(/°/g, '° ')
  .replace(/([ぁ-んァ-ヶ一-龠])(?=[0-9])/g, '$1 ')
  .split(/[\sx×,]+/)
  .filter((a) => a.length > 0 && !/^[a-z]$/.test(a)) // 1文字の英字（B・N等）は照合に使わない
  .map(canonAtom);

// 品目側の照合キー: アトム列を空白区切りで並べたもの（境界判定のため）
// prevNames は品名を統一したときの旧品名。集計表は業者の書き方で来るため
// （豫洲のTP-Aは外径27.2x2.0で来る）、旧品名を残さないと統一した品目に当たらなくなる。
export function matchKeyOf(it) {
  if (!it._mk) {
    it._mk = ' ' + atomize([it.name, ...(it.prevNames || []), it.category, it.material, it.spec, it.supplier]
      .join(' ')).join(' ') + ' ';
  }
  return it._mk;
}

// 境界チェックつき部分一致（後読み正規表現は古いiOS Safariで動かないため手書き）
// badBefore/badAfter: 隣接するとNGな文字のパターン
function hitWithBounds(mk, a, badBefore, badAfter) {
  let i = mk.indexOf(a);
  while (i !== -1) {
    const b = i > 0 ? mk[i - 1] : ' ';
    const c = i + a.length < mk.length ? mk[i + a.length] : ' ';
    if (!badBefore.test(b) && !badAfter.test(c)) return true;
    i = mk.indexOf(a, i + 1);
  }
  return false;
}

export function atomHit(mk, a) {
  if (/^\d+$/.test(a)) {
    // 純粋な数値: 前後に数字や小数点が続く一致は誤爆（25↔125, 3↔3.5）なので弾く。
    // 前に許す英字はネジ径のM・丸径のφだけ（s10のようなスケジュール記号への誤爆を防ぐ）。
    // 後ろに許す英字は呼び径のAだけ（10↔10k、15↔15k等への誤爆を防ぐ）。
    if (hitWithBounds(mk, a, /[0-9.a-ln-z]/, /[0-9.b-z]/)) return true;
    const n = parseInt(a, 10);
    if (n >= 1000 && n % 100 === 0) {
      // 5500 ↔ 5.5m / 6000 ↔ 6m の単位ゆれ
      if (hitWithBounds(mk, (n / 1000) + 'm', /[0-9a-z.]/, /[0-9a-z]/)) return true;
      if (hitWithBounds(mk, (n / 1000) + '.0m', /[0-9a-z.]/, /[0-9a-z]/)) return true;
    }
    return false;
  }
  if (/\d/.test(a)) {
    // 数字まじり（32A・SUS304・5.5m等）: 英数字の地続きは別物（SUS316↔SUS316L）
    return hitWithBounds(mk, a, /[0-9a-z.]/, /[0-9a-z]/);
  }
  if (/^[a-z#.']+$/.test(a)) {
    // 英字だけの語（SGP・FBH等）: 英数字の地続きは別物
    return hitWithBounds(mk, a, /[0-9a-z]/, /[0-9a-z]/);
  }
  return mk.includes(a); // 日本語の語は単純部分一致
}
// 加工品らしい行（一点物。マスターには登録しない前提で仕分けを促す）
const looksFab = (row) => /型切|角切|穴明|レーザー|ﾚｰｻﾞｰ|加工/.test(row.name + row.spec);

export function matchRow(row) {
  const ak = aliasKey(row.name, row.material, row.spec);
  const exact = cache.items.find((it) => (it.aliases || []).includes(ak));
  if (exact) return { kind: 'auto', item: exact, viaAlias: true };
  const nameAtoms = atomize([row.name, row.spec].join(' '));
  const matAtoms = atomize(row.material || '');
  const atoms = [...nameAtoms, ...matAtoms];
  if (!atoms.length) return { kind: 'none', candidates: [] };
  // 必須の数値 = 名称・形格の数値 ＋ 材質の英数字（SUS304等）。
  // ただし付属記号（FW2・SW2・N2・UBN2等 = 英字1〜3字+数字）は寸法ではないので必須にしない。
  // 材質欄の「純粋な数字だけ」（「25」「36」等の記入ゆれ）も必須にしない（一致すれば加点のみ）。
  const isAccessory = (a) => /^[a-z]{1,3}\d$/.test(a);
  const nums = [
    ...nameAtoms.filter((a) => /\d/.test(a) && !isAccessory(a)),
    ...matAtoms.filter((a) => /\d/.test(a) && /[a-z]/.test(a) && !isAccessory(a)),
  ];
  const softNums = [
    ...atoms.filter((a) => /\d/.test(a) && isAccessory(a)),
    ...matAtoms.filter((a) => /^[\d.]+$/.test(a)),
  ];
  const words = atoms.filter((a) => !/\d/.test(a));
  // 品名（D列）由来の語。これが1つも一致しない品目への「自動」は危険なので許さない
  //（皿小ネジ→六角ボルト、ショートエルボ→ロングエルボ等の誤接続を防ぐ）
  const nameWords = atomize(row.name).filter((a) => !/\d/.test(a));
  const scored = [];
  let best = null;
  for (const it of cache.items) {
    const mk = matchKeyOf(it);
    let nHit = 0, wWord = 0, wSoft = 0;
    for (const a of nums) if (atomHit(mk, a)) nHit++;
    for (const a of softNums) if (atomHit(mk, a)) wSoft++;
    for (const a of words) if (atomHit(mk, a)) wWord++;
    const wHit = wWord + wSoft;
    const score = (nHit + wHit) / atoms.length;
    if (score >= 0.5) scored.push({ it, score });
    // 自動の条件を満たす中で最も一致の多い品目を採用
    //（「溶協品」の行が同サイズの「黒」につながる等の取り違えを防ぐ。
    //  語（材質・種別）の一致は付属記号の一致より重く見る）
    const nameOk = !nameWords.length || nameWords.some((a) => atomHit(mk, a));
    if (!looksFab(row) && nums.length >= 2 && nHit === nums.length && wHit >= 1 && nameOk) {
      const h = nHit * 3 + wWord * 2 + wSoft;
      if (!best || h > best.h || (h === best.h && (it.useCount || 0) > (best.it.useCount || 0))) best = { it, h };
    }
  }
  if (best) return { kind: 'auto', item: best.it, viaAlias: false };
  scored.sort((a, b) => b.score - a.score || (b.it.useCount || 0) - (a.it.useCount || 0));
  return { kind: scored.length && !looksFab(row) ? 'cand' : 'none', candidates: scored.slice(0, 3).map((s) => s.it), fabLikely: looksFab(row) };
}

function priceOf(row, item) {
  // kg単価の行はkgPriceと、個/本の行はcostと比べる
  return row.isKg ? { cur: item.kgPrice, kind: 'kg単価' } : { cur: item.cost, kind: '個/本単価' };
}

export function parseSheet(XLSX, buf) {
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

export function openTallyPage() {
  const ov = openOverlay();
  let rows = null, result = null, applied = false;

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
          ${/* PCは 左＝集計表の生表記／右＝候補ボタン の2カラム（tl-row）。
                キーボードだけで流せるよう、ボタンの並び順は変えない */ ''}
          ${[...result.cand, ...result.none].map((row, i) => `
            <div class="card tl-row" style="margin-top:8px">
              <div class="tl-left">
                <div class="ttl" style="font-size:14px">${esc(row.name)}</div>
                <div class="meta">${esc([row.material, row.spec].filter(Boolean).join(' ／ '))}　${row.price != null ? `<b class="num">${YEN(row.price)}</b>／${row.isKg ? 'kg' : esc(row.unit || '個')}` : '単価なし'}　<span class="num">${esc(row.orderNo)}</span></div>
              </div>
              <div class="tl-right">
                ${row.resolved ? `<div style="font-size:13px;color:var(--green);font-weight:700">✓ ${esc(row.resolved)}</div>` : `
                  <div style="font-size:12px;font-weight:700;color:var(--muted)">これですか?</div>
                  <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
                    ${(row.match.candidates || []).map((c, ci) => `<button class="btn btn-sm" style="justify-content:flex-start" data-pick="${i}|${ci}">${esc(c.name)}（${c.cost != null ? YEN(c.cost) : '—'}）</button>`).join('')}
                    <div style="display:flex;gap:6px;flex-wrap:wrap">
                      <button class="btn btn-sm" data-new="${i}">マスターに無い→新規</button>
                      <button class="btn btn-sm" data-skip1="${i}">加工品・購入品（登録しない）</button>
                      <button class="btn btn-sm" data-skip2="${i}">工具・消耗品（対象外）</button>
                    </div>
                  </div>`}
              </div>
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
