// ============================================================
// 発注待ち一覧（事務所の主戦場）と 案件をさがす
// ============================================================

import { esc, YEN, fmtDateJa, toDate, local } from './util.js?v=11';
import { openOverlay, toast, confirmDialog, bindSearch } from './ui.js?v=11';
import { cache, norm, updateEstimate, createEstimate, addLine } from './store.js?v=11';
import { db, collection, getDocs } from './firebase.js?v=11';
import { exportEstimateCsv } from './export.js?v=11';

// 仕入先名 → 発注メール統合名（小野建／小野建 SUS／小野建（継手）→ 小野建）
function mergeNameOf(supplierName) {
  if (!supplierName) return '（仕入先なし）';
  const s = cache.suppliers.find((x) => x.name === supplierName);
  if (s && s.mergeName) return s.mergeName;
  const m = supplierName.match(/^(小野建)/);
  return m ? m[1] : supplierName;
}

// 経過時間の表示と色（〜半日=灰／1日=山吹／2日以上=赤）
function elapsed(est) {
  const d = toDate(est.orderRequestedAt);
  if (!d) return { text: '', color: 'var(--muted2)' };
  const h = (Date.now() - d.getTime()) / 3600000;
  const text = h < 1 ? `${Math.max(1, Math.round(h * 60))}分前` : (h < 24 ? `${Math.round(h)}時間前` : `${Math.floor(h / 24)}日前`);
  const color = h < 12 ? 'var(--muted2)' : (h < 48 ? 'var(--accent)' : 'var(--red)');
  return { text, color };
}

// ============================================================
// 発注待ち一覧
// ============================================================
export function openOrderWaitPage() {
  const ov = openOverlay();
  const linesCache = {};   // estId → lines

  async function loadLines(estId) {
    if (linesCache[estId]) return linesCache[estId];
    const snap = await getDocs(collection(db, 'estimates', estId, 'lines'));
    linesCache[estId] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return linesCache[estId];
  }

  async function paint() {
    const waits = cache.estimates.filter((e) => e.status === '発注待ち');
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <button class="icon-btn" id="ow-back">←</button>
        <span class="ttl">発注待ち一覧</span>
      </div></div>
      <div class="page-body"><div style="padding:12px">
        ${waits.length ? '<div id="ow-list">読み込み中…</div>'
          : '<div class="empty"><div class="big">発注待ちはありません</div>現場が「発注依頼を出す」と、ここに溜まります（プッシュ通知は使いません）</div>'}
      </div></div>`;
    ov.el.querySelector('#ow-back').addEventListener('click', ov.close);
    if (!waits.length) return;

    const cards = await Promise.all(waits.map(async (e) => {
      const lines = await loadLines(e.id);
      // 仕入先ごとにまとめる（材料＋外注）
      const groups = {};
      for (const l of lines) {
        if (l.kind !== '材料' && l.kind !== '外注') continue;
        const g = mergeNameOf(l.supplier);
        groups[g] = (groups[g] || 0) + 1;
      }
      const st = e.orderStatus || {};
      const el = elapsed(e);
      return `
        <div class="card" style="margin-bottom:10px" data-est="${e.id}">
          <div class="ttl" style="font-size:15px">${esc(e.customer ? e.customer + '様 ' : '')}${esc(e.projectName || '（工事名なし）')}</div>
          <div class="meta"><span class="num">${e.orderNo ? '注番 ' + esc(e.orderNo) : ''}</span>　担当：${esc(e.staff || '—')}</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">
            ${Object.entries(groups).map(([g, n]) => `
              <label style="display:inline-flex;align-items:center;gap:6px;border:1px solid ${st[g] ? 'var(--line2)' : 'var(--navy)'};border-radius:6px;padding:8px 10px;font-size:13.5px;cursor:pointer;${st[g] ? 'color:var(--muted2);background:#F3F5F8' : ''}">
                <input type="checkbox" data-sup="${esc(g)}" ${st[g] ? 'checked' : ''} style="width:18px;height:18px">
                ${esc(g)} ${n}品目${st[g] ? '（発注済み）' : ''}
              </label>`).join('') || '<span style="font-size:12.5px;color:var(--muted2)">仕入先のある明細がありません</span>'}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px">
            <span style="font-size:12px;color:var(--muted)">納品：${esc(e.deliveryPlace || '—')}　希望納期：${esc(e.dueDate || '—')}</span>
            <span style="font-size:12px;font-weight:700;color:${el.color}">${el.text}</span>
          </div>
          <button class="btn btn-sm" style="margin-top:10px" data-csv="${e.id}">Excelへ渡す（CSV）</button>
        </div>`;
    }));
    const listEl = ov.el.querySelector('#ow-list');
    if (!listEl) return;
    listEl.innerHTML = cards.join('');

    listEl.querySelectorAll('input[data-sup]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        const estId = cb.closest('[data-est]').dataset.est;
        const e = cache.estimates.find((x) => x.id === estId);
        const st = { ...(e.orderStatus || {}) };
        if (cb.checked) st[cb.dataset.sup] = '発注済み'; else delete st[cb.dataset.sup];
        try {
          const patch = { orderStatus: st };
          // 全社そろったら進行中へ（「受注」の合図）
          const lines = await loadLines(estId);
          const groups = new Set(lines.filter((l) => (l.kind === '材料' || l.kind === '外注') && l.supplier).map((l) => mergeNameOf(l.supplier)));
          if ([...groups].every((g) => st[g])) {
            patch.status = '進行中';
            toast('すべて発注済み。進行中に移しました');
          }
          await updateEstimate(estId, patch);
          setTimeout(paint, 400);
        } catch (err) { console.error(err); toast('保存できませんでした'); }
      });
    });
    listEl.querySelectorAll('[data-csv]').forEach((b) => b.addEventListener('click', async () => {
      const e = cache.estimates.find((x) => x.id === b.dataset.csv);
      const lines = await loadLines(e.id);
      const warnings = exportEstimateCsv(e, lines, { ...cache.rates, ...(e.rates || {}) }, { ...cache.unitRates, ...(e.unitRates || {}) });
      toast(warnings.length ? '⚠ ' + warnings.join('／') : 'CSVを書き出しました');
    }));
  }

  paint();
}

// ============================================================
// 案件をさがす（50件枠なし・揺れに強い検索・コピーして新規）
// ============================================================
export function renderSearchTab(container) {
  let q = '';

  // iPhone対策: 検索inputは一度だけ生成し、絞り込みでは結果リストだけ描き直す
  //（詳細は ui.js の bindSearch のコメント参照）
  container.innerHTML = `
    <div class="screen">
      <div class="search-block">
        <div class="search-box" style="height:48px">
          <input id="s-q" placeholder="工事名・宛先・注番・担当者" autocomplete="off" style="font-size:16px">
        </div>
      </div>
      <div class="scroll" id="s-list"></div>
    </div>`;
  const listEl = container.querySelector('#s-list');
  bindSearch(container.querySelector('#s-q'), (v) => { q = v; paint(); });

  function paint() {
    const tokens = norm(q).split(' ').filter(Boolean);
    const hits = !tokens.length ? cache.estimates : cache.estimates.filter((e) => {
      const key = norm([e.projectName, e.customer, e.orderNo, e.staff, e.site].join(' '));
      return tokens.every((t) => key.includes(t));
    });

    listEl.innerHTML = `
          <div class="sec-head"><span class="ttl">見つかった案件</span><span class="cnt">${hits.length}</span><span class="rule"></span></div>
          ${hits.slice(0, 50).map((e) => `
            <div class="card" style="margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
                <div class="ttl" style="font-size:15px;cursor:pointer;flex:1" data-open="${e.id}">${esc(e.projectName || '（工事名なし）')}</div>
                <span style="font-size:11.5px;color:var(--muted2);flex:none">${esc(e.status || '')}</span>
              </div>
              <div class="meta">${esc(e.customer || '')}　<span class="num">${e.orderNo ? '注番 ' + esc(e.orderNo) : ''}</span>　担当：${esc(e.staff || '—')}</div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
                <span class="num" style="font-weight:700;color:var(--navy)">${YEN(e.totalFinal || 0)}</span>
                <button class="btn btn-sm" data-copy="${e.id}">コピーして新規</button>
              </div>
            </div>`).join('') || '<div class="empty">見つかりませんでした</div>'}
          ${hits.length > 50 ? '<div style="text-align:center;font-size:12px;color:var(--muted2);padding:8px">50件まで表示。検索で絞ってください</div>' : ''}`;

    listEl.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => {
      location.hash = '#est/' + el.dataset.open;
    }));
    listEl.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      const src = cache.estimates.find((x) => x.id === b.dataset.copy);
      if (!src) return;
      if (!(await confirmDialog(`「${src.projectName || '（工事名なし）'}」をコピーして新しい見積を作りますか?\n（注番は空になります。率は今の設定値）`, 'コピーする'))) return;
      try {
        const newId = await createEstimate(local.get('staff', ''));
        await updateEstimate(newId, {
          projectName: src.projectName || '', site: src.site || '',
          customer: src.customer || '', welfareOn: src.welfareOn !== false,
        });
        const snap = await getDocs(collection(db, 'estimates', src.id, 'lines'));
        let order = Date.now();
        for (const d of snap.docs) {
          const { ...data } = d.data();
          await addLine(newId, { ...data, order: order++ });
        }
        location.hash = '#est/' + newId;
        toast('コピーしました。注番と数量を確かめてください');
      } catch (e) { console.error(e); toast('コピーできませんでした'); }
    }));
  }

  paint();
}
