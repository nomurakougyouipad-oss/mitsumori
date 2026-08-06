// ============================================================
// 概算から本見積へ（画面6）
//   ・見積タブの一覧 … 概算／本見積／完工 を1本の流れで見せる
//   ・本見積にする   … 何を引き継ぎ、何を作り直すかを見せてから作る
//   ・完工にする     … 請求額を入れて実績を1件残す
//   ・過去の工事を入れる … 見積が無い実績（社長の記憶から）
//
// 【概算はそのまま残る】本見積を作っても概算は消えない。上書きもしない。
// 実績も別に残る。だから一覧には3つとも並ぶ。
// ============================================================

import { esc, YEN, fmtDate, fmtDateJa, toDate, local } from './util.js?v=33';
import { icons } from './icons.js?v=33';
import { openOverlay, openNumpad, toast, confirmDialog } from './ui.js?v=33';
import { cache, onCacheChange } from './store.js?v=33';
import { Timestamp } from './firebase.js?v=33';
import { WORK_TYPES } from './rough-calc.js?v=33';
import {
  createRough, subscribeRoughItems, freezeRough, convertToEstimate, materialOriginOf,
} from './rough-store.js?v=33';
import { addActual, completeEstimate, diffOf, newActual, summarizeByWorkType } from './actuals.js?v=33';

// ---------- 一覧に並べるもの ----------
// 概算・本見積・完工を1本にまとめて、新しい順に並べる。
const BADGE = {
  概算:  { bg: '#1B3A5C' },
  本見積: { bg: '#1F6B5B' },
  完工:  { bg: '#8A96A3' },
  実績:  { bg: '#8A96A3' },
};

const ms = (v) => { const d = toDate(v); return d ? d.getTime() : 0; };

// 差の書き方。ぴったり同じときに「−0」と出さない
function gapText(gap) {
  if (gap === 0) return '±0';
  return (gap > 0 ? '+' : '−') + Math.abs(gap).toLocaleString('ja-JP');
}
function gapColor(gap) {
  if (gap === 0) return 'var(--muted2)';
  return gap < 0 ? 'var(--green)' : '#B0480F';
}

function buildRows() {
  const rows = [];

  for (const r of cache.roughs || []) {
    if (r.status === '完工') continue;              // 完工は下の実績カードで出す
    rows.push({
      kind: '概算', id: r.id, at: ms(r.updatedAt),
      title: r.projectName, customer: r.customer, site: r.site, staff: r.staff,
      amount: r.totalsFrozen?.withTax ?? r.totalFinal ?? 0,
      pending: r.pendingCount || 0,
      band: r.bandFrozen || null,
      converted: !!r.convertedEstimateId,
      rough: r,
    });
  }

  for (const e of cache.estimates || []) {
    if (e.status === '完工') continue;
    rows.push({
      kind: '本見積', id: e.id, at: ms(e.updatedAt),
      title: e.projectName, customer: e.customer, site: e.site, staff: e.staff,
      amount: e.totalFinal || 0,
      pending: e.pendingCount || 0,
      fromRoughId: e.fromRoughId || null,
      roughTotal: e.roughTotal ?? null,
      band: e.roughBand || null,
      est: e,
    });
  }

  for (const a of cache.actuals || []) {
    const d = diffOf(a);
    rows.push({
      kind: a.source === 'memory' ? '実績' : '完工',
      id: a.id, at: ms(a.completedAt) || ms(a.createdAt),
      title: a.projectName, customer: a.customer, staff: a.staff,
      amount: a.billedAmount ?? 0,
      diff: d, actual: a,
      estimateId: a.estimateId || null,
    });
  }

  return rows.sort((x, y) => y.at - x.at);
}

function badgeHtml(kind) {
  const b = BADGE[kind] || BADGE.概算;
  return `<span style="height:24px;padding:0 9px;background:${b.bg};border-radius:4px;color:#fff;
    font-size:12px;font-weight:700;display:inline-flex;align-items:center">${kind}</span>`;
}

function subLine(row) {
  // row.at はミリ秒。fmtDateJa は Timestamp か Date を取るので包んで渡す
  const bits = [row.customer, row.site, row.at ? fmtDateJa(new Date(row.at)) : '', row.staff].filter(Boolean);
  return bits.join(' ／ ');
}

function cardHtml(row) {
  // 完工・実績は「概算 → 実績（差）」を出す
  let foot = '';
  if (row.diff) {
    const d = row.diff;
    const base = d.roughTotal != null ? d.roughTotal : d.estimateTotal;
    const gap = d.roughTotal != null ? d.vsRough : d.vsEstimate;
    const label = d.roughTotal != null ? '概算' : '本見積';
    if (base != null && gap != null) {
      foot = `<div style="font-size:12px;color:var(--muted);padding-top:6px">
        ${label} <span class="num">${YEN(base)}</span> → 実績 <span class="num">${YEN(d.billed)}</span>
        <span style="color:${gapColor(gap)};font-weight:700">（${gapText(gap)}）</span></div>`;
    } else if (row.actual?.source === 'memory') {
      foot = '<div style="font-size:12px;color:var(--muted2);padding-top:6px">思い出して入れた実績（見積なし）</div>';
    }
  }

  let action = '';
  if (row.kind === '概算' && !row.converted) {
    action = `<button class="btn btn-primary btn-block" style="margin-top:12px;height:46px" data-convert="${row.id}">本見積にする</button>`;
  } else if (row.kind === '概算' && row.converted) {
    action = '<div style="font-size:12px;color:var(--muted2);padding-top:8px">本見積を作りました。この概算はそのまま残ります</div>';
  } else if (row.kind === '本見積') {
    action = `<button class="btn btn-block" style="margin-top:12px;height:46px" data-complete="${row.id}">完工にする</button>`;
  }

  return `
    <div class="card" data-open="${row.kind}:${row.id}" style="cursor:pointer">
      <div>${badgeHtml(row.kind)}</div>
      <div class="ttl" style="padding-top:8px">${esc(row.title || '（工事名なし）')}</div>
      ${subLine(row) ? `<div class="meta">${esc(subLine(row))}</div>` : ''}
      <div style="display:flex;align-items:flex-end;justify-content:space-between;padding-top:10px">
        <span class="yen">${YEN(row.amount)}</span>
        ${row.pending ? `<span style="font-size:12px;color:var(--accent);font-weight:700;padding-bottom:3px">単価待ち ${row.pending}件</span>` : ''}
      </div>
      ${foot}
      ${action}
    </div>`;
}

// ---------- 見積タブ ----------
export function renderQuotesTab(container) {
  const rows = buildRows();
  container.innerHTML = `
    <div class="screen">
      <div class="scroll est-list-scroll">
        ${rows.length ? rows.map(cardHtml).join('') : `
          <div class="empty"><div class="big">まだありません</div>
            概算を作るか、下から過去の工事を入れてください</div>`}
        <div style="height:8px"></div>
      </div>
      <div class="bottom-action">
        <button class="btn btn-primary btn-block btn-big" id="q-new">${icons.plus}あたらしい概算</button>
        <button class="btn btn-block" id="q-actual" style="height:48px;margin-top:8px">${icons.flag}過去の工事を入れる</button>
      </div>
    </div>`;

  container.querySelectorAll('[data-convert]').forEach((el) => el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openConvertPage(el.dataset.convert);
  }));
  container.querySelectorAll('[data-complete]').forEach((el) => el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openCompletePage({ estimateId: el.dataset.complete });
  }));
  container.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => {
    const [kind, id] = el.dataset.open.split(':');
    if (kind === '本見積') location.hash = '#est/' + id;
    else if (kind === '完工') {
      const a = (cache.actuals || []).find((x) => x.id === id);
      if (a?.estimateId) location.hash = '#est/' + a.estimateId;
      else openActualEditPage(a);
    } else if (kind === '実績') {
      openActualEditPage((cache.actuals || []).find((x) => x.id === id));
    } else if (kind === '概算') {
      location.hash = '#rough/' + id;
    }
  }));
  container.querySelector('#q-actual').addEventListener('click', () => openActualEditPage(null));
  container.querySelector('#q-new').addEventListener('click', async () => {
    try {
      const id = await createRough(local.get('staff', ''));
      sessionStorage.setItem('openRoughCover', id);   // 新規はまず表紙から
      location.hash = '#rough/' + id;
    } catch (e) { console.error(e); toast('作れませんでした'); }
  });
}

// ============================================================
// 本見積にする
// ============================================================

// 確認画面の中身。何を引き継ぎ、何を作り直すかを見せる。
// items が null のあいだは読み込み中（この間は「本見積を作る」を押させない）。
export function convertSummaryHtml(rough, items) {
  const photos = (rough.photos || []).length;
  const work = (items || []).filter((i) => i.kind !== '材料' && i.state === '確定');
  const materials = (items || []).filter((i) => materialOriginOf(i));
  const keepMaterials = (items || []).filter((i) => i.kind === '材料' && !materialOriginOf(i));

  const originLabel = (i) => {
    const o = materialOriginOf(i);
    if (o === 'market') return `<span class="num" style="color:var(--muted)">相場 ${YEN(i.marketAmount)}</span>`;
    if (o === 'manual') return `<span class="num" style="color:var(--muted)">直した ${YEN(i.manualAmount)}</span>`;
    return '<span style="font-size:12.5px;color:var(--accent);font-weight:700">単価待ち</span>';
  };

  const keepRow = (t) => `
    <div style="display:flex;align-items:center;gap:8px;min-height:42px;padding:6px 0;
      border-bottom:1px solid #F0F2F5;font-size:14px;color:var(--text)">
      <span style="color:var(--green);display:grid;place-items:center">${icons.check}</span>${t}</div>`;

  return `<div class="form-page">
    <div style="font-size:14px;line-height:1.7;padding-bottom:12px">
      本見積を作ります。<b>概算はそのまま残ります。</b></div>

    <div style="font-size:12px;font-weight:700;color:var(--green);padding:2px 2px 8px">そのまま引き継ぐもの</div>
    <div style="background:#fff;border:1px solid var(--line);border-radius:6px;padding:2px 16px">
      ${keepRow('工事名・宛先・施工場所')}
      ${keepRow(photos ? `写真 ${photos}枚` : '写真（まだありません）')}
      ${keepRow(items === null ? '作業の行…' : `作業の行 ${work.length}件（人工そのまま）`)}
      ${keepRow('現場移動費・外注費')}
      ${keepMaterials.length ? keepRow(`材料 ${keepMaterials.length}件（単価マスターから採ったもの）`) : ''}
      <div style="display:flex;align-items:center;gap:8px;min-height:42px;padding:6px 0;font-size:14px">
        <span style="color:var(--green);display:grid;place-items:center">${icons.check}</span>率（材料15%・諸経費15%・法定福利費16%・損料5%）</div>
    </div>

    ${materials.length ? `
      <div style="font-size:12px;font-weight:700;color:var(--accent);padding:16px 2px 8px">作り直すもの</div>
      <div style="background:#FBF2E4;border:1px solid var(--accent);border-radius:6px;padding:12px 14px">
        <div style="font-size:13px;color:#5C3D0B;padding-bottom:8px;line-height:1.6">
          材料 ${materials.length}件 …「一式いくら」を、1本ずつに割ります</div>
        <div style="background:#fff;border-radius:6px;padding:2px 12px">
          ${materials.map((i, n) => `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:40px;
              padding:6px 0;font-size:13.5px;color:var(--text)
              ${n < materials.length - 1 ? ';border-bottom:1px solid #F0F2F5' : ''}">
              <span style="min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(i.name || '（名前なし）')}</span>
              ${originLabel(i)}</div>`).join('')}
        </div>
      </div>` : (items === null ? '' : `
      <div style="font-size:12px;color:var(--muted2);padding:16px 2px 0;line-height:1.7">
        割り直しの要る材料はありません。</div>`)}

    ${items === null ? '<div class="empty" style="padding:24px">読み込み中…</div>' : ''}
  </div>`;
}

export function openConvertPage(roughId) {
  const rough = (cache.roughs || []).find((r) => r.id === roughId);
  if (!rough) { toast('概算が見つかりません'); return; }

  const ov = openOverlay();
  let items = null;
  let busy = false;

  const stop = subscribeRoughItems(roughId, (list) => { items = list; paint(); });
  const close = () => { stop(); ov.close(); };

  function paint() {
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <button class="icon-btn" id="c-back">←</button><span class="ttl">本見積にする</span>
      </div></div>
      <div class="page-body">${convertSummaryHtml(rough, items)}</div>
      <div class="bottom-bar" style="display:flex;gap:8px">
        <button class="btn" style="flex:1;height:52px" id="c-cancel">やめる</button>
        <button class="btn btn-primary" style="flex:1.4;height:52px" id="c-go" ${items === null || busy ? 'disabled' : ''}>本見積を作る</button>
      </div>`;

    ov.el.querySelector('#c-back').addEventListener('click', close);
    ov.el.querySelector('#c-cancel').addEventListener('click', close);
    ov.el.querySelector('#c-go').addEventListener('click', go);
  }

  async function go() {
    if (busy || items === null) return;
    busy = true; paint();
    try {
      // 概算を出したときの率と金額を焼き付けておく（まだなら）。
      // お客様に伝えた幅を本見積へ渡すのに要る。
      if (!rough.ratesFrozen) {
        const f = await freezeRough(roughId, rough, items, local.get('staff', ''));
        rough.ratesFrozen = f ? (rough.ratesFrozen || null) : null;
        rough.bandFrozen = { low: f.band.displayLow, high: f.band.displayHigh };
        rough.totalsFrozen = f.totals;
      }
      const estId = await convertToEstimate(roughId, rough, items, local.get('staff', ''));
      close();
      toast('本見積を作りました。概算はそのまま残っています');
      location.hash = '#est/' + estId;
    } catch (e) {
      console.error(e); busy = false; paint();
      toast('作れませんでした。電波を確認してください');
    }
  }

  paint();
}

// ============================================================
// 本見積の「概算との差」— 見積画面の上に出す帯
// est.roughTotal / est.roughBand がある本見積だけに出る
// ============================================================
export function roughDiffHtml(est, t) {
  if (!est || est.roughTotal == null) return '';
  // 費目は4つとも出す。移動費を隠すと、行を足しても税込合計に届かなくなる
  const rows = [
    ['材料費', est.roughKinds?.material, t.material],
    ['労務費', est.roughKinds?.labor, t.labor],
    ['現場移動費', est.roughKinds?.travel, t.travel],
    ['外注費', est.roughKinds?.subcontract, t.subcontract],
  ].filter((r) => r[1] || r[2]);

  const cell = (v) => v == null ? '—' : Math.round(v).toLocaleString('ja-JP');
  const gapCell = (a, b) => {
    if (a == null || b == null) return '<span style="color:var(--muted2)">—</span>';
    const g = Math.round(b - a);
    return `<span style="color:${gapColor(g)}">${gapText(g)}</span>`;
  };
  const grid = 'display:grid;grid-template-columns:1fr 68px 68px 62px;gap:4px;align-items:center';

  const now = Math.round(t.final);
  const band = est.roughBand;
  let verdict = '';
  if (band && band.high != null) {
    if (now > band.high) {
      const over = now - band.high;
      verdict = `
        <div style="margin-top:10px;padding:12px;background:#FBF2E4;border:1px solid var(--accent);border-radius:6px">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="color:var(--accent);display:grid;place-items:center;font-size:18px">${icons.warning}</span>
            <span style="font-size:13.5px;font-weight:700;color:#5C3D0B">お客様に伝えた <span class="num">${YEN(band.high)}</span> を <span class="num">${YEN(over)}</span> 超えています</span>
          </div>
          <div style="font-size:12.5px;color:#5C3D0B;padding-top:6px;line-height:1.6">出す前に、お客様に連絡してください</div>
        </div>`;
    } else if (band.low != null && now < band.low) {
      verdict = `
        <div style="margin-top:10px;padding:10px 12px;background:#E9F3EF;border-radius:6px;font-size:12px;color:#1F6B5B;line-height:1.5">
          お客様に伝えた幅 <span class="num" style="font-weight:700">${YEN(band.low)}〜${YEN(band.high)}</span> より安く収まりました</div>`;
    } else {
      verdict = `
        <div style="display:flex;align-items:center;gap:8px;margin-top:10px;padding:10px 12px;background:#E9F3EF;border-radius:6px">
          <span style="color:var(--green);display:grid;place-items:center;font-size:18px">${icons.checkCircle}</span>
          <div style="font-size:12px;color:#1F6B5B;line-height:1.5">お客様に伝えた幅 <span class="num" style="font-weight:700">${YEN(band.low)}〜${YEN(band.high)}</span> の中に収まっています</div>
        </div>`;
    }
  }

  return `
    <div style="background:#fff;border-bottom:1px solid var(--line);padding:12px 14px">
      <div style="${grid};font-size:11px;color:var(--muted2);font-weight:700;padding-bottom:6px">
        <span></span>
        <span style="text-align:right">概算${toDate(est.roughDate) ? '(' + fmtDateJa(est.roughDate) + ')' : ''}</span>
        <span style="text-align:right">本見積</span><span style="text-align:right">差</span>
      </div>
      ${rows.map(([lbl, a, b]) => `
        <div style="${grid};font-size:12.5px;color:var(--text);padding:3px 0">
          <span>${lbl}</span>
          <span class="num" style="text-align:right">${cell(a)}</span>
          <span class="num" style="text-align:right">${cell(b)}</span>
          <span class="num" style="text-align:right">${gapCell(a, b)}</span>
        </div>`).join('')}
      <div style="height:1px;background:var(--line2);margin:6px 0"></div>
      <div style="${grid};font-size:14px;font-weight:700;color:var(--text)">
        <span>税込合計</span>
        <span class="num" style="text-align:right">${cell(est.roughTotal)}</span>
        <span class="num" style="text-align:right;color:var(--navy)">${cell(now)}</span>
        <span class="num" style="text-align:right">${gapCell(est.roughTotal, now)}</span>
      </div>
      ${verdict}
    </div>`;
}

// ============================================================
// 完工にする
// ============================================================
export function openCompletePage({ estimateId = null, roughId = null }) {
  const est = estimateId ? (cache.estimates || []).find((e) => e.id === estimateId) : null;
  const rough = roughId
    ? (cache.roughs || []).find((r) => r.id === roughId)
    : (est?.fromRoughId ? (cache.roughs || []).find((r) => r.id === est.fromRoughId) : null);

  const roughTotal = rough ? (rough.totalsFrozen?.withTax ?? rough.totalFinal ?? null) : (est?.roughTotal ?? null);
  const estTotal = est?.totalFinal ?? null;

  const ov = openOverlay();
  let billed = estTotal ?? null;          // 既定は本見積の金額（そのまま請求することが多い）
  let day = new Date();
  let note = '';
  let busy = false;

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  function preview() {
    const base = roughTotal != null ? roughTotal : estTotal;
    const label = roughTotal != null ? '概算' : '本見積';
    if (base == null || billed == null) return '';
    const gap = billed - base;
    return `
      <div style="background:#fff;border:1px solid var(--line);border-radius:6px;padding:12px 14px;margin-bottom:16px">
        <div style="font-size:12px;color:var(--muted);padding-bottom:4px">一覧にはこう出ます</div>
        <div style="font-size:13.5px;line-height:1.7">
          ${label} <span class="num">${YEN(base)}</span> → 実績 <span class="num">${YEN(billed)}</span>
          <span style="color:${gapColor(gap)};font-weight:700">（${gapText(gap)}）</span>
        </div>
      </div>`;
  }

  function paint() {
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <button class="icon-btn" id="k-back">←</button><span class="ttl">完工にする</span>
      </div></div>
      <div class="page-body"><div class="form-page">
        <div style="font-size:14px;line-height:1.7;padding-bottom:14px">
          ${esc(est?.projectName || rough?.projectName || 'この工事')}を完工にします。<br>
          <b>見積の金額は書き換えません。</b>実績として別に残します。</div>

        <div class="field">
          <label>最終の請求金額（税込）</label>
          <button class="rate-input" id="k-billed" style="width:100%;height:56px;justify-content:flex-end">
            <b style="font-size:24px">${billed == null ? '—' : billed.toLocaleString('ja-JP')}</b><span>円</span></button>
        </div>

        <div class="field">
          <label>完工日</label>
          <input class="input" type="date" id="k-date" value="${iso(day)}">
        </div>

        ${preview()}

        <div class="field">
          <label>ひとこと（要らなければ空のまま）</label>
          <input class="input" id="k-note" value="${esc(note)}" placeholder="例）追加工事あり" autocomplete="off">
        </div>

        <div style="font-size:11.5px;color:var(--muted2);line-height:1.7">
          ここに溜まった実績が、次の概算を「相場」ではなく<b>よつばの金額</b>にします。</div>
      </div></div>
      <div class="bottom-bar" style="display:flex;gap:8px">
        <button class="btn" style="flex:1;height:52px" id="k-cancel">やめる</button>
        <button class="btn btn-primary" style="flex:1.4;height:52px" id="k-go" ${busy ? 'disabled' : ''}>完工にする</button>
      </div>`;

    ov.el.querySelector('#k-back').addEventListener('click', ov.close);
    ov.el.querySelector('#k-cancel').addEventListener('click', ov.close);
    ov.el.querySelector('#k-billed').addEventListener('click', () => {
      openNumpad({ title: '請求金額（税込）', value: billed ?? '', unit: '円', allowDecimal: false,
        onDone: (n) => { if (n != null) { billed = n; paint(); } } });
    });
    ov.el.querySelector('#k-date').addEventListener('change', (e) => {
      const d = new Date(e.target.value);
      if (!isNaN(d.getTime())) day = d;
    });
    ov.el.querySelector('#k-note').addEventListener('input', (e) => { note = e.target.value; });
    ov.el.querySelector('#k-go').addEventListener('click', go);
  }

  async function go() {
    if (busy) return;
    if (billed == null) { toast('請求金額を入れてください'); return; }
    if (!(await confirmDialog(`請求 ${YEN(billed)} で完工にします。よろしいですか?`, '完工にする'))) return;
    busy = true; paint();
    try {
      await completeEstimate({
        estimateId, roughId: rough?.id || null,
        billedAmount: billed, completedAt: Timestamp.fromDate(day),
        staff: local.get('staff', ''), note,
      });
      ov.close();
      toast('完工にしました。実績が1件たまりました');
    } catch (e) {
      console.error(e); busy = false; paint();
      toast('保存できませんでした。電波を確認してください');
    }
  }

  paint();
}

// ============================================================
// 実績の一覧（設定から）
// 工事の種類ごとに、よつばがいくらでやってきたかが見える
// ============================================================
export function openActualsListPage() {
  const ov = openOverlay();

  function paint() {
    const list = cache.actuals || [];
    const byType = WORK_TYPES.map((w) => {
      const s = summarizeByWorkType(list, w);
      return { w, ...s };
    });

    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <button class="icon-btn" id="l-back">←</button><span class="ttl">完工した工事</span>
      </div></div>
      <div class="page-body"><div class="form-page">
        <div style="font-size:12px;font-weight:700;color:var(--muted);padding-bottom:8px">工事の種類ごと</div>
        <div style="background:#fff;border:1px solid var(--line);border-radius:6px;padding:2px 14px;margin-bottom:18px">
          ${byType.map((s, n) => `
            <div style="padding:10px 0${n < byType.length - 1 ? ';border-bottom:1px solid #F0F2F5' : ''}">
              <div style="display:flex;align-items:center;justify-content:space-between">
                <span style="font-size:14.5px">${esc(s.w)}</span>
                <span class="num" style="font-size:13px;color:var(--muted)">${s.count}件</span>
              </div>
              ${s.enough
                ? `<div style="font-size:13px;color:var(--text);padding-top:4px">まん中 <b class="num">${YEN(s.median)}</b>
                     <span style="color:var(--muted2);font-size:12px">（${YEN(s.min)} 〜 ${YEN(s.max)}）</span></div>`
                : `<div style="font-size:12px;color:var(--muted2);padding-top:4px">あと${3 - s.count}件たまると出ます</div>`}
            </div>`).join('')}
        </div>

        <div style="font-size:12px;font-weight:700;color:var(--muted);padding-bottom:8px">1件ずつ</div>
        ${list.length ? list.map((a) => {
          const d = diffOf(a);
          const base = d.roughTotal ?? d.estimateTotal;
          const gap = d.roughTotal != null ? d.vsRough : d.vsEstimate;
          return `
            <div class="card" data-a="${a.id}" style="cursor:pointer">
              <div style="display:flex;align-items:center;gap:8px">
                ${badgeHtml(a.source === 'memory' ? '実績' : '完工')}
                <span style="font-size:12px;color:var(--muted)">${esc(a.workType || '')}</span>
                <span style="margin-left:auto;font-size:12px;color:var(--muted2)" class="num">${fmtDate(a.completedAt)}</span>
              </div>
              <div class="ttl" style="font-size:15px;padding-top:6px">${esc(a.projectName || '（工事名なし）')}</div>
              ${a.customer ? `<div class="meta">${esc(a.customer)}</div>` : ''}
              <div style="display:flex;align-items:baseline;justify-content:space-between;padding-top:8px">
                <span class="num" style="font-size:22px;font-weight:700;color:var(--navy)">${YEN(a.billedAmount ?? 0)}</span>
                ${a.persons && a.days ? `<span style="font-size:12px;color:var(--muted)">${a.persons}人 × ${a.days}日</span>` : ''}
              </div>
              ${base != null && gap != null ? `
                <div style="font-size:12px;color:var(--muted);padding-top:4px">
                  ${d.roughTotal != null ? '概算' : '本見積'} <span class="num">${YEN(base)}</span> →
                  <span style="color:${gapColor(gap)};font-weight:700">${gapText(gap)}</span></div>` : ''}
            </div>`;
        }).join('') : '<div class="empty">まだありません</div>'}
      </div></div>
      <div class="bottom-bar">
        <button class="btn btn-primary btn-block" style="height:52px" id="l-add">${icons.plus}過去の工事を入れる</button>
      </div>`;

    ov.el.querySelector('#l-back').addEventListener('click', ov.close);
    ov.el.querySelector('#l-add').addEventListener('click', () => openActualEditPage(null));
    ov.el.querySelectorAll('[data-a]').forEach((el) => el.addEventListener('click', () => {
      openActualEditPage((cache.actuals || []).find((x) => x.id === el.dataset.a));
    }));
  }

  paint();
  const stop = onCacheChange(() => { if (ov.el.isConnected) paint(); });
  const origClose = ov.close;
  ov.close = () => { stop(); origClose(); };
}

// ============================================================
// 過去の工事を入れる（見積が無い実績）
// 社長の記憶から。注番も工事名も要らない。必要なのは4つだけ。
// actual を渡すと、その1件を見る画面になる。
// ============================================================
export function openActualEditPage(actual = null) {
  const ov = openOverlay();
  const viewing = !!actual;
  const d = actual || newActual({ workType: WORK_TYPES[0], source: 'memory' });
  const f = {
    workType: d.workType || WORK_TYPES[0],
    projectName: d.projectName || '',
    customer: d.customer || '',
    persons: d.persons ?? null,
    days: d.days ?? null,
    materialCost: d.materialCost ?? null,
    billedAmount: d.billedAmount ?? null,
    completedAt: toDate(d.completedAt) || new Date(),
  };
  let busy = false;

  const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const numRow = (key, label, unit) => `
    <div class="field">
      <label>${label}</label>
      <button class="rate-input" data-n="${key}" style="width:100%;height:52px;justify-content:flex-end">
        <b>${f[key] == null ? '—' : f[key].toLocaleString('ja-JP')}</b><span>${unit}</span></button>
    </div>`;

  function paint() {
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <button class="icon-btn" id="a-back">←</button>
        <span class="ttl">${viewing ? '実績' : '過去の工事を入れる'}</span>
      </div></div>
      <div class="page-body"><div class="form-page">
        ${viewing ? '' : `
          <div style="font-size:13px;color:var(--muted);line-height:1.8;padding-bottom:14px">
            思い出せる分だけで構いません。<b>注番も工事名も要りません。</b><br>
            例）モーター整備、2人で5日、材料35万、請求148万<br>
            <span style="color:var(--muted2)">分からない欄は空のままにしてください。0にしないでください。</span></div>`}

        <div class="field">
          <label>工事の種類</label>
          <div class="chips" style="flex-wrap:wrap">
            ${WORK_TYPES.map((w) => `<div class="chip ${f.workType === w ? 'on' : ''}" data-w="${esc(w)}">${esc(w)}</div>`).join('')}
          </div>
        </div>

        ${numRow('persons', '何人で', '人')}
        ${numRow('days', '何日かかったか', '日')}
        ${numRow('materialCost', '材料はいくらだったか', '円')}
        ${numRow('billedAmount', '最終の請求金額（税込）', '円')}

        <div class="field">
          <label>完工日</label>
          <input class="input" type="date" id="a-date" value="${iso(f.completedAt)}">
        </div>

        <div class="field">
          <label>工事名（覚えていれば）</label>
          <input class="input" id="a-name" value="${esc(f.projectName)}" autocomplete="off">
        </div>
        <div class="field">
          <label>宛先（覚えていれば）</label>
          <input class="input" id="a-cust" value="${esc(f.customer)}" autocomplete="off">
        </div>

        ${f.billedAmount != null && f.persons && f.days ? `
          <div style="background:#fff;border:1px solid var(--line);border-radius:6px;padding:12px 14px;font-size:13px;color:var(--muted)">
            人日あたり <b class="num" style="color:var(--text)">${YEN(f.billedAmount / (f.persons * f.days))}</b>
          </div>` : ''}
      </div></div>
      <div class="bottom-bar" style="display:flex;gap:8px">
        <button class="btn" style="flex:1;height:52px" id="a-cancel">${viewing ? '閉じる' : 'やめる'}</button>
        ${viewing ? '' : `<button class="btn btn-primary" style="flex:1.4;height:52px" id="a-go" ${busy ? 'disabled' : ''}>入れる</button>`}
      </div>`;

    ov.el.querySelector('#a-back').addEventListener('click', ov.close);
    ov.el.querySelector('#a-cancel').addEventListener('click', ov.close);
    ov.el.querySelectorAll('[data-w]').forEach((el) => el.addEventListener('click', () => {
      f.workType = el.dataset.w; paint();
    }));
    ov.el.querySelectorAll('[data-n]').forEach((el) => el.addEventListener('click', () => {
      const k = el.dataset.n;
      const labels = { persons: '何人で', days: '何日', materialCost: '材料', billedAmount: '請求金額（税込）' };
      openNumpad({ title: labels[k], value: f[k] ?? '', unit: k === 'persons' ? '人' : k === 'days' ? '日' : '円',
        allowDecimal: k === 'days', onDone: (n) => { f[k] = n; paint(); } });
    }));
    ov.el.querySelector('#a-date').addEventListener('change', (e) => {
      const dt = new Date(e.target.value);
      if (!isNaN(dt.getTime())) f.completedAt = dt;
    });
    ov.el.querySelector('#a-name').addEventListener('input', (e) => { f.projectName = e.target.value; });
    ov.el.querySelector('#a-cust').addEventListener('input', (e) => { f.customer = e.target.value; });
    const go = ov.el.querySelector('#a-go');
    if (go) go.addEventListener('click', save);
  }

  async function save() {
    if (busy) return;
    if (f.billedAmount == null) { toast('請求金額だけは入れてください'); return; }
    busy = true; paint();
    try {
      await addActual({
        ...f,
        completedAt: Timestamp.fromDate(f.completedAt),
        staff: local.get('staff', ''),
        source: 'memory',
      });
      ov.close();
      toast('実績を1件入れました');
    } catch (e) {
      console.error(e); busy = false; paint();
      toast('保存できませんでした');
    }
  }

  paint();
}
