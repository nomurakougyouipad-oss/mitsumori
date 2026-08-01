// ============================================================
// 発注待ち一覧（事務所の主戦場）と 案件をさがす
// ============================================================

import { esc, YEN, fmtDateJa, toDate, local } from './util.js?v=18';
import { openOverlay, toast, confirmDialog, bindSearch } from './ui.js?v=18';
import { cache, norm, updateEstimate, createEstimate, addLine, deleteEstimateDeep } from './store.js?v=18';
import { db, collection, getDocs } from './firebase.js?v=18';
import { exportEstimateCsv } from './export.js?v=18';

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
    // PCでは1行＝1案件の一覧表（何件溜まっているか一目で分かることを優先）。
    // 見出し行はPCだけ表示し、スマホでは従来どおりカードとして縦に積む。
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <button class="icon-btn" id="ow-back">←</button>
        <span class="ttl">発注待ち一覧　${waits.length}件</span>
      </div></div>
      <div class="page-body">
        ${waits.length ? `
          <div class="ow-table">
            <div class="ow-head">
              <span>工事名・宛先</span><span>担当</span><span>注番</span>
              <span>仕入先ごとの発注</span><span>納品場所</span><span>希望納期</span>
              <span>経過</span><span>操作</span>
            </div>
            <div id="ow-list" style="padding:12px">読み込み中…</div>
          </div>`
          : '<div class="empty"><div class="big">発注待ちはありません</div>現場が「発注依頼を出す」と、ここに溜まります（プッシュ通知は使いません）</div>'}
      </div>`;
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
      const done = Object.keys(groups).filter((g) => st[g]).length;
      const total = Object.keys(groups).length;
      return `
        <div class="ow-row" data-est="${e.id}">
          <div class="c-name">
            <span class="nm">${esc(e.projectName || '（工事名なし）')}</span>
            <span class="sub">${esc(e.customer ? e.customer + '様' : '')}</span>
          </div>
          <div class="c-staff"><span class="lb">担当</span>${esc(e.staff || '—')}</div>
          <div class="c-order"><span class="lb">注番</span><span class="num">${esc(e.orderNo || '—')}</span></div>
          <div class="c-sup">
            ${total ? `<span class="sup-count">${done}/${total}</span>` : ''}
            ${Object.entries(groups).map(([g, n]) => `
              <label class="sup-chip ${st[g] ? 'on' : ''}">
                <input type="checkbox" data-sup="${esc(g)}" ${st[g] ? 'checked' : ''}>
                ${esc(g)} ${n}品目
              </label>`).join('') || '<span class="none">仕入先のある明細がありません</span>'}
          </div>
          <div class="c-place"><span class="lb">納品</span>${esc(e.deliveryPlace || '—')}</div>
          <div class="c-due"><span class="lb">希望納期</span>${esc(e.dueDate || '—')}</div>
          <div class="c-elapsed" style="color:${el.color}">${el.text}</div>
          <div class="c-act"><button class="btn btn-sm" data-csv="${e.id}">Excelへ渡す</button></div>
        </div>`;
    }));
    const listEl = ov.el.querySelector('#ow-list');
    if (!listEl) return;
    listEl.innerHTML = cards.join('');
    listEl.removeAttribute('style');   // 読み込み中の余白を外して表として詰める

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
// 見積の削除（ホームと「案件をさがす」で共用）
// 明細ごと消えて元に戻せないので、工事名と金額を見せて必ず確認をとる。
// 状態（見積中／発注待ち／進行中）は問わない — テストで作ったものも消せるように。
// ============================================================
export async function confirmDeleteEstimate(est) {
  if (!est) return false;
  const name = est.projectName || '（工事名なし）';
  const msg = `「${name}」\n${YEN(est.totalFinal || 0)}（税込）${est.orderNo ? '　注番 ' + est.orderNo : ''}\n\n`
    + 'この見積を削除しますか?\n明細も含めて完全に消えます。元に戻せません。';
  if (!(await confirmDialog(msg, '削除する'))) return false;
  try {
    await deleteEstimateDeep(est.id);
    toast(`「${name}」を削除しました`);
    return true;
  } catch (e) { console.error(e); toast('削除できませんでした'); return false; }
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
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px">
                <span class="num" style="font-weight:700;color:var(--navy)">${YEN(e.totalFinal || 0)}</span>
                <div style="display:flex;align-items:center;gap:8px;flex:none">
                  <button class="btn btn-sm" data-copy="${e.id}">コピーして新規</button>
                  <button class="card-del" data-del="${e.id}" aria-label="この見積を削除">🗑</button>
                </div>
              </div>
            </div>`).join('') || '<div class="empty">見つかりませんでした</div>'}
          ${hits.length > 50 ? '<div style="text-align:center;font-size:12px;color:var(--muted2);padding:8px">50件まで表示。検索で絞ってください</div>' : ''}`;

    listEl.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => {
      location.hash = '#est/' + el.dataset.open;
    }));
    listEl.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (await confirmDeleteEstimate(cache.estimates.find((x) => x.id === b.dataset.del))) paint();
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
