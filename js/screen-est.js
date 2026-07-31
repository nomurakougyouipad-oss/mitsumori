// ============================================================
// 見積画面 — 明細一覧（費目タブ）・表紙の情報・見積の確認
// ============================================================

import { esc, YEN, fmtDateJa, local } from './util.js?v=8';
import { icons } from './icons.js?v=8';
import { openOverlay, openNumpad, toast, confirmDialog } from './ui.js?v=8';
import {
  cache, subscribeEstimate, subscribeLines, updateEstimate,
  addLine, deleteLine, saveSummary, addNamed,
} from './store.js?v=8';
import { totals, lineAmount, excelRound } from './calc.js?v=8';
import {
  db, doc, updateDoc, deleteDoc, getDocs, collection, Timestamp, arrayUnion, arrayRemove,
  storageRef, uploadBytes, getDownloadURL, deleteObject, storage,
} from './firebase.js?v=8';
import {
  openMaterialPage, openManualPage, openPendingPage,
  openLaborPage, openTravelPage, openSubcontractPage,
} from './screen-material.js?v=8';
import { exportEstimateCsv } from './export.js?v=8';

const KINDS = ['材料', '労務', '移動', '外注'];
const KIND_LABEL = { 材料: '材料費', 労務: '労務費', 移動: '移動費', 外注: '外注費' };

// 見積のレートセット（見積に写した率を優先）
function ratesOf(est) { return { ...cache.rates, ...(est.rates || {}) }; }
function unitRatesOf(est) { return { ...cache.unitRates, ...(est.unitRates || {}) }; }

function calcAll(est, lines) {
  return totals(lines, ratesOf(est), unitRatesOf(est), est.welfareOn !== false, est.adjust || 0);
}

// ============================================================
// 明細一覧画面
// ============================================================
export function renderEstScreen(container, estId) {
  let est = null, lines = [], kind = '材料';
  let lastSummary = '';

  container.innerHTML = '<div class="empty" style="padding-top:80px">読み込み中…</div>';

  const unsubEst = subscribeEstimate(estId, (e) => {
    if (!e) { location.hash = '#home'; return; }
    est = e;
    // 「単価が入りました」の印は、見たら消える
    if (e.priceFilled) updateEstimate(estId, { priceFilled: false }).catch(() => {});
    paint();
  });
  const unsubLines = subscribeLines(estId, (ls) => {
    lines = ls;
    paint();
    pushSummary();
  });

  // 集計サマリーを見積ドキュメントに写す（値が変わったときだけ）
  async function pushSummary() {
    if (!est) return;
    const t = calcAll(est, lines);
    const sig = `${lines.length}|${lines.filter((l) => l.pendingPrice).length}|${Math.round(t.final)}`;
    const cur = `${est.linesCount || 0}|${est.pendingCount || 0}|${est.totalFinal || 0}`;
    if (sig !== cur && sig !== lastSummary) {
      lastSummary = sig;
      try { await saveSummary(estId, t, lines); } catch (e) { console.warn(e); }
    }
  }

  function lineTitle(l) {
    if (l.kind === '労務') return `${l.trade || l.name}<small>${l.persons}人 × ${l.hours}h</small>`;
    if (l.kind === '移動') return `${esc(l.name || '現場移動')}<small>${l.persons}人 × ${l.hours}h${l.km != null ? ` ／ ${l.km}km` : ''}</small>`;
    if (l.kind === '外注') return `${esc(l.supplier || '外注')}<small>${esc(l.name || '')}</small>`;
    return esc(l.name);
  }

  function paint() {
    if (!est) return;
    const t = calcAll(est, lines);
    const byKind = (k) => lines.filter((l) => l.kind === k);
    const kindLines = byKind(kind);
    const subLbl = { 材料: t.material, 労務: t.labor, 移動: t.travel, 外注: t.subcontract }[kind];
    const coverBits = [est.projectName, est.customer, est.site,
      (est.sketchPhotos || []).length ? `スケッチ写真${est.sketchPhotos.length}枚` : ''].filter(Boolean);

    container.innerHTML = `
      <div class="screen">
        <div class="est-header" style="padding-top: env(safe-area-inset-top, 0px)">
          <div class="row1">
            <button class="icon-btn" id="e-back" style="color:#fff;background:none;border:0;width:44px;height:44px;font-size:24px;cursor:pointer">←</button>
            <div style="flex:1;min-width:0">
              <div class="ttl">${esc(est.projectName || '（工事名なし）')}</div>
              <div class="meta"><span class="num">${est.orderNo ? '注番 ' + esc(est.orderNo) : '注番なし'}</span>${est.customer ? ' ／ ' + esc(est.customer) : ''}</div>
              <div class="saved">☁ 自動保存されます</div>
            </div>
          </div>
        </div>
        <button class="cover-row" id="e-cover">
          <span class="main">表紙の情報</span>
          <span class="sub">${coverBits.length ? esc(coverBits.join('・')) : '工事名・宛先・注番・スケッチ写真'}</span>
          <span style="color:var(--muted)">›</span>
        </button>
        <div class="feetabs">
          ${KINDS.map((k) => `<div class="ftab ${k === kind ? 'on' : ''}" data-k="${k}">${KIND_LABEL[k]}<b>${byKind(k).length}</b></div>`).join('')}
        </div>
        <div class="lines" id="e-lines">
          ${kindLines.length ? kindLines.map((l) => lineRowHtml(l)).join('') :
            `<div class="empty" style="padding:36px 24px">${KIND_LABEL[kind]}はまだありません</div>`}
          ${kindLines.length ? `<div class="subtotal-row"><span class="lbl">${KIND_LABEL[kind]} 小計</span><span class="v">${YEN(subLbl)}</span></div>` : ''}
          <div style="height:24px"></div>
        </div>
        <div class="bottom-bar">
          <button class="btn btn-primary btn-block" style="height:52px;font-size:17px" id="e-add">＋ ${KIND_LABEL[kind]}を追加</button>
          <div class="total-row" id="e-total" style="cursor:pointer">
            <span class="lbl">税込 ${est.pendingCount ? '<span class="pend-inline">⏱ 単価待ち ' + est.pendingCount + '件</span>' : ''}</span>
            <span class="v">${YEN(t.final)} ›</span>
          </div>
        </div>
      </div>`;

    container.querySelector('#e-back').addEventListener('click', () => { location.hash = '#home'; });
    container.querySelector('#e-cover').addEventListener('click', () => openCoverPage(estId, () => est));
    container.querySelectorAll('.ftab').forEach((el) => el.addEventListener('click', () => { kind = el.dataset.k; paint(); }));
    container.querySelector('#e-add').addEventListener('click', () => openAdd());
    container.querySelector('#e-total').addEventListener('click', () => openConfirmPage(estId));
    bindLineEvents();
  }

  function lineRowHtml(l) {
    const amt = lineAmount(l, ratesOf(est), unitRatesOf(est));
    const amtHtml = l.pendingPrice && !(l.tempCost > 0)
      ? '<span class="amt pending">単価待ち</span>'
      : `<span class="amt">${amt != null ? YEN(excelRound(amt)) : '—'}</span>`;
    const mark = l.pendingPrice ? '<span class="mark">⏱</span>' : (l.handwritten ? '<span class="mark">✎</span>' : '');
    const qtyPill = l.kind === '材料'
      ? `<span class="qty-pill" data-qty="${l.id}"><b>${l.qty ?? 0}</b><span>${esc(l.unit || '')}</span></span>` : '';
    return `
      <div class="swipe-wrap" data-line="${l.id}">
        <div class="swipe-actions">
          <button class="a-copy" data-copy="${l.id}">⧉<span>複製</span></button>
          <button class="a-del" data-del="${l.id}">🗑<span>削除</span></button>
        </div>
        <div class="swipe-front">
          <div class="line-row" data-open="${l.id}">
            ${mark}
            <span class="nm">${lineTitle(l)}</span>
            ${qtyPill}
            ${amtHtml}
          </div>
        </div>
      </div>`;
  }

  function findLine(id) { return lines.find((x) => x.id === id); }

  function openAdd(prefill) {
    const opts = prefill ? { prefill } : {};
    if (kind === '材料') openMaterialPage(estId, est, opts);
    else if (kind === '労務') openLaborPage(estId, est, opts);
    else if (kind === '移動') openTravelPage(estId, est, opts);
    else openSubcontractPage(estId, est, opts);
  }

  function openEdit(l) {
    const prefill = { ...l, lineId: l.id };
    if (l.kind === '材料') {
      if (l.pendingPrice) openPendingPage(estId, est, { prefill });
      else if (l.handwritten) openManualPage(estId, est, { prefill });
      else openMaterialPage(estId, est, { prefill });
    } else if (l.kind === '労務') openLaborPage(estId, est, { prefill });
    else if (l.kind === '移動') openTravelPage(estId, est, { prefill });
    else openSubcontractPage(estId, est, { prefill });
  }

  function bindLineEvents() {
    // 数量のその場テンキー（ページは動かさない）
    container.querySelectorAll('[data-qty]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const l = findLine(el.dataset.qty);
        if (!l) return;
        openNumpad({
          title: '数量', value: l.qty ?? '', unit: l.unit || '',
          onDone: async (n) => {
            if (n == null) return;
            try {
              await updateDoc(doc(db, 'estimates', estId, 'lines', l.id), { qty: n });
            } catch (err) { console.error(err); toast('保存できませんでした'); }
          },
        });
      });
    });
    // 行タップ → 編集ページ
    container.querySelectorAll('[data-open]').forEach((el) => {
      el.addEventListener('click', () => {
        const l = findLine(el.dataset.open);
        if (l) openEdit(l);
      });
    });
    // 複製 → 入力ページが値入りで開く（保存はまだされない）
    container.querySelectorAll('[data-copy]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const l = findLine(el.dataset.copy);
        if (!l) return;
        const { id, order, ...rest } = l;
        openAddForKind(l.kind, rest);
      });
    });
    // 削除 → 取り消しつき
    container.querySelectorAll('[data-del]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const l = findLine(el.dataset.del);
        if (!l) return;
        const { id, ...data } = l;
        try {
          await deleteLine(estId, id);
          toast('1行削除しました', '↩ 戻す', async () => {
            try { await addLine(estId, data); } catch (err) { console.error(err); }
          });
        } catch (err) { console.error(err); toast('削除できませんでした'); }
      });
    });
    // 左スワイプで複製/削除を出す
    container.querySelectorAll('.swipe-wrap').forEach(attachSwipe);
  }

  function openAddForKind(k, prefill) {
    const opts = { prefill };
    if (k === '材料') {
      if (prefill.pendingPrice) openPendingPage(estId, est, opts);
      else if (prefill.handwritten) openManualPage(estId, est, opts);
      else openMaterialPage(estId, est, opts);
    } else if (k === '労務') openLaborPage(estId, est, opts);
    else if (k === '移動') openTravelPage(estId, est, opts);
    else openSubcontractPage(estId, est, opts);
  }

  function attachSwipe(wrap) {
    const front = wrap.querySelector('.swipe-front');
    const W = 152;
    let startX = null, startY = null, open = false, dragging = false;
    wrap.addEventListener('pointerdown', (e) => { startX = e.clientX; startY = e.clientY; dragging = false; });
    wrap.addEventListener('pointermove', (e) => {
      if (startX == null) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!dragging && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) dragging = true;
      if (dragging) {
        front.style.transition = 'none';
        const base = open ? -W : 0;
        front.style.transform = `translateX(${Math.max(-W, Math.min(0, base + dx))}px)`;
      }
    });
    const end = (e) => {
      if (startX == null) return;
      const dx = e.clientX - startX;
      front.style.transition = '';
      if (dragging) {
        const base = open ? -W : 0;
        open = (base + dx) < -W / 2;
        front.style.transform = `translateX(${open ? -W : 0}px)`;
        // スワイプ直後の行タップ（編集）を抑止
        if (Math.abs(dx) > 12) {
          const block = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
          front.addEventListener('click', block, { capture: true, once: true });
          setTimeout(() => front.removeEventListener('click', block, { capture: true }), 300);
        }
      }
      startX = null;
    };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
  }

  return () => { unsubEst(); unsubLines(); };
}

// ============================================================
// 表紙の情報（工事名・宛先・施工場所・注番・担当者・スケッチ写真）
// ============================================================
export function openCoverPage(estId, getEst) {
  const ov = openOverlay();
  let saveTimers = {};

  function debounceSave(key, patch) {
    clearTimeout(saveTimers[key]);
    saveTimers[key] = setTimeout(() => updateEstimate(estId, patch).catch((e) => { console.error(e); toast('保存できませんでした'); }), 600);
  }

  function paint() {
    const est = getEst();
    if (!est) { ov.close(); return; }
    const pastNames = [...new Set(cache.estimates.map((e) => e.projectName).filter(Boolean))].slice(0, 50);
    const pastSites = [...new Set(cache.estimates.map((e) => e.site).filter(Boolean))].slice(0, 50);
    const dup = est.orderNo && cache.estimates.some((e) => e.id !== estId && e.orderNo === est.orderNo);

    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <button class="icon-btn" id="c-back">←</button>
        <span class="ttl">表紙の情報</span>
      </div></div>
      <div class="page-body"><div class="form-page">
        <div class="field"><label>工事名（手打ちが基本。空でも保存されます）</label>
          <input class="input" id="c-name" value="${esc(est.projectName || '')}" list="c-names" autocomplete="off">
          <datalist id="c-names">${pastNames.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></div>
        <div class="field"><label>宛先（取引先）</label>
          <select class="input" id="c-customer">
            <option value="">（未選択）</option>
            ${cache.customers.map((c) => `<option value="${esc(c.name)}" ${est.customer === c.name ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            <option value="__new__">＋ 新しい取引先を追加</option>
          </select></div>
        <div class="field"><label>施工場所</label>
          <input class="input" id="c-site" value="${esc(est.site || '')}" list="c-sites" autocomplete="off">
          <datalist id="c-sites">${pastSites.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></div>
        <div class="field"><label>注文番号</label>
          <input class="input num" id="c-orderno" value="${esc(est.orderNo || '')}" autocomplete="off" placeholder="OT26249">
          ${dup ? '<div style="color:#8A560F;font-size:12.5px;font-weight:700;margin-top:6px">⚠ この注番はすでに使われています（Excel移行期は特に注意）</div>' : ''}
          <div style="display:flex;gap:8px;margin-top:8px">
            <select class="input" id="c-prefix" style="flex:1">
              <option value="">自動採番（系列を選ぶ）…</option>
              ${knownPrefixes().map((p) => `<option value="${p}">${p}（${p}${yy()}の続き番号）</option>`).join('')}
            </select>
          </div>
          <div style="font-size:11px;color:var(--muted2);margin-top:4px">アプリ内の最大＋1を提案します。Excel側と混在中は番号を確かめてください</div>
          <select class="input" id="c-standing" style="margin-top:8px">
            <option value="">常設注番から選ぶ…</option>
            ${cache.standingOrders.map((s) => `<option value="${esc(s.orderNo)}">${esc(s.orderNo)}　${esc(s.name)}${s.staff ? '（' + esc(s.staff) + '）' : ''}</option>`).join('')}
          </select></div>
        <div class="field"><label>担当者</label>
          <select class="input" id="c-staff">
            ${[...new Set([est.staff, ...cache.staff.map((s) => s.name)].filter(Boolean))]
              .map((n) => `<option value="${esc(n)}" ${est.staff === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}
          </select></div>
        <div class="field"><label>拾い出しスケッチの写真</label>
          <div class="photo-grid" id="c-photos">
            ${(est.sketchPhotos || []).map((u, i) => `<img class="ph" src="${esc(u)}" data-ph="${i}">`).join('')}
            <button class="ph-add" id="c-addph">📷<span>追加</span></button>
            <input type="file" id="c-file" accept="image/*" style="display:none">
          </div></div>
        <div style="margin-top:24px;border-top:1px solid var(--line);padding-top:16px">
          <button class="btn btn-danger btn-block" id="c-delete">この見積を削除する</button>
        </div>
      </div></div>
      <div class="bottom-bar">
        <button class="btn btn-primary btn-block btn-big" id="c-done">明細の入力へ</button>
      </div>`;

    const est0 = est;
    ov.el.querySelector('#c-back').addEventListener('click', ov.close);
    ov.el.querySelector('#c-done').addEventListener('click', ov.close);
    ov.el.querySelector('#c-name').addEventListener('input', (e) => debounceSave('name', { projectName: e.target.value }));
    ov.el.querySelector('#c-site').addEventListener('input', (e) => debounceSave('site', { site: e.target.value }));
    ov.el.querySelector('#c-orderno').addEventListener('input', (e) => debounceSave('orderNo', { orderNo: e.target.value.trim() }));
    ov.el.querySelector('#c-staff').addEventListener('change', (e) => updateEstimate(estId, { staff: e.target.value }));

    // 宛先: 選んだ時点で法定福利費の初期値が入る
    ov.el.querySelector('#c-customer').addEventListener('change', async (e) => {
      const v = e.target.value;
      if (v === '__new__') { await addCustomerFlow(); paint(); return; }
      const c = cache.customers.find((x) => x.name === v);
      await updateEstimate(estId, { customer: v, welfareOn: c ? !c.noWelfare : true });
      toast(c && c.noWelfare ? 'この宛先は法定福利費なしです（確認画面で変えられます）' : '法定福利費を計上します');
    });

    // 自動採番: プレフィックス選択 → その系列の既存最大+1を提案（手で直せる）
    ov.el.querySelector('#c-prefix').addEventListener('change', async (e) => {
      const p = e.target.value;
      if (!p) return;
      const proposal = proposeOrderNo(p);
      await updateEstimate(estId, { orderNo: proposal });
      setTimeout(paint, 300);
    });

    // 常設注番: 選ぶと注番＋担当者が入る
    ov.el.querySelector('#c-standing').addEventListener('change', async (e) => {
      const so = cache.standingOrders.find((s) => s.orderNo === e.target.value);
      if (!so) return;
      const patch = { orderNo: so.orderNo };
      if (so.staff) patch.staff = so.staff;
      await updateEstimate(estId, patch);
      setTimeout(paint, 300);
    });

    // 写真
    const file = ov.el.querySelector('#c-file');
    ov.el.querySelector('#c-addph').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      toast('写真をアップロード中…');
      try {
        const blob = await shrinkImage(f, 1600);
        const ref = storageRef(storage, `sketchPhotos/${estId}/${Date.now()}.jpg`);
        await uploadBytes(ref, blob, { contentType: 'image/jpeg' });
        const url = await getDownloadURL(ref);
        await updateDoc(doc(db, 'estimates', estId), { sketchPhotos: arrayUnion(url) });
        toast('写真を追加しました');
        setTimeout(paint, 300);
      } catch (e) { console.error(e); toast('アップロードできませんでした（電波を確認）'); }
    });
    ov.el.querySelectorAll('[data-ph]').forEach((img) => img.addEventListener('click', () => viewPhoto(img.src)));

    // 見積の削除（明細ごと消す。二重確認）
    ov.el.querySelector('#c-delete').addEventListener('click', async () => {
      if (!(await confirmDialog('この見積を削除しますか?', '削除する'))) return;
      if (!(await confirmDialog('明細も含めて完全に消えます。本当に削除しますか?', '完全に削除'))) return;
      try {
        const snap = await getDocs(collection(db, 'estimates', estId, 'lines'));
        for (const d0 of snap.docs) await deleteDoc(d0.ref);
        await deleteDoc(doc(db, 'estimates', estId));
        ov.close();
        location.hash = '#home';
        toast('見積を削除しました');
      } catch (e) { console.error(e); toast('削除できませんでした'); }
    });
  }

  async function addCustomerFlow() {
    const name = prompt('取引先の名前');
    if (!name || !name.trim()) return;
    const noWelfare = !(await confirmDialog(`「${name.trim()}」に法定福利費を計上しますか?`, '計上する'));
    await addNamed('customers', { name: name.trim(), email: '', noWelfare });
    await updateEstimate(estId, { customer: name.trim(), welfareOn: !noWelfare });
  }

  function viewPhoto(url) {
    const root = document.getElementById('modal-root');
    const v = document.createElement('div');
    v.className = 'photo-view';
    v.innerHTML = `
      <img src="${esc(url)}">
      <div class="pv-bar">
        <button class="btn btn-danger" id="pv-del">この写真を削除</button>
        <button class="btn" id="pv-x" style="color:#fff;border-color:#fff;background:transparent">閉じる</button>
      </div>`;
    root.appendChild(v);
    v.querySelector('#pv-x').addEventListener('click', () => v.remove());
    v.querySelector('#pv-del').addEventListener('click', async () => {
      if (!(await confirmDialog('この写真を削除しますか?', '削除する'))) return;
      try {
        await updateDoc(doc(db, 'estimates', estId), { sketchPhotos: arrayRemove(url) });
        try { await deleteObject(storageRef(storage, url)); } catch (_) { /* URL参照で消せない場合は残す */ }
        v.remove();
        setTimeout(paint, 300);
      } catch (e) { console.error(e); toast('削除できませんでした'); }
    });
  }

  paint();
}

// ---------- 注番の自動採番 ----------
// 形式: アルファベット2文字＋年2桁＋連番3桁（例 OT26265）。枝番 -01-01 は無視。
// 000は常設の受け皿・888は特別枠なので提案から外す。知らない形式は判定しない。
function yy() { return String(new Date().getFullYear() % 100).padStart(2, '0'); }

function knownPrefixes() {
  const set = new Set();
  for (const s of cache.standingOrders) {
    const m = (s.orderNo || '').match(/^([A-Z]{2})\d{5}/);
    if (m) set.add(m[1]);
  }
  for (const e of cache.estimates) {
    const m = (e.orderNo || '').match(/^([A-Z]{2})\d{5}/);
    if (m) set.add(m[1]);
  }
  return [...set].sort();
}

function proposeOrderNo(prefix) {
  const year = yy();
  let max = 0;
  for (const e of cache.estimates) {
    const m = (e.orderNo || '').match(new RegExp('^' + prefix + year + '(\\d{3})'));
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n === 0 || n === 888) continue; // 受け皿・特別枠は連番に数えない
    if (n > max) max = n;
  }
  let next = max + 1;
  if (next === 888) next = 889;
  return prefix + year + String(next).padStart(3, '0');
}

// 画像を縮小してJPEG化（アップロードを軽くする）
async function shrinkImage(file, maxSize) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
}

// ============================================================
// 見積の確認
// ============================================================
export function openConfirmPage(estId) {
  const ov = openOverlay();
  let est = null, lines = [], rateOpen = false;

  const unsubEst = subscribeEstimate(estId, (e) => { est = e; paint(); });
  const unsubLines = subscribeLines(estId, (ls) => { lines = ls; paint(); });
  const origClose = ov.close;
  ov.close = () => { unsubEst(); unsubLines(); origClose(); };

  function paint() {
    if (!est) return;
    const r = ratesOf(est);
    const t = calcAll(est, lines);
    const pending = lines.filter((l) => l.pendingPrice && !(l.tempCost > 0)).length;
    const provisional = pending > 0;
    const welfareOn = est.welfareOn !== false;

    const row = (lbl, v, opt = {}) => `
      <div class="bd-row ${opt.cls || ''}">
        <span>${lbl}${opt.badge ? `<span class="rate-badge">${opt.badge}</span>` : ''}${opt.extra || ''}</span>
        <span class="v">${v}</span>
      </div>`;

    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <button class="icon-btn" id="cf-back">←</button>
        <span class="ttl">見積の確認</span>
      </div></div>
      <div class="page-body">
        <div class="hero">
          <div class="lbl">${provisional ? '暫定の合計' : '御見積金額'}</div>
          <div class="amt-row">
            <span class="amt">${YEN(t.final)}</span>
            ${provisional ? '<span class="tag-warn big">⚠ 暫定</span>' : ''}
          </div>
          <div class="meta">${esc(est.projectName || '（工事名なし）')}<br><span class="num">${est.orderNo ? '注番 ' + esc(est.orderNo) : ''}</span></div>
        </div>
        ${provisional ? `<div class="warn-banner">${icons.warning}
          <span>単価が決まっていない品目が <b>${pending}</b> 件あります。事務所が金額を入れるまで確定できません</span></div>` : ''}
        <div class="bd-card">
          <div class="head">内訳</div>
          ${row('材料費', YEN(t.material), { extra: pending ? `<span class="pend-inline">⏱ ${pending}件 単価待ち</span>` : '' })}
          ${row('労務費', YEN(t.labor))}
          ${row('現場移動費', YEN(t.travel), { cls: t.travel === 0 ? 'zero' : '' })}
          ${row('外注費', YEN(t.subcontract), { cls: t.subcontract === 0 ? 'zero' : '' })}
          ${row('諸経費', YEN(t.overhead), { cls: 'sub2', badge: pct(r.overhead) })}
          ${welfareOn ? row('法定福利費', YEN(t.welfare), { cls: 'sub2', badge: pct(r.welfare) }) : ''}
          ${row('損料', YEN(t.depreciation), { cls: 'sub2', badge: pct(r.depreciation) })}
          <div class="bd-sep"></div>
          ${row('税抜', YEN(t.taxable), { cls: 'small' })}
          ${row(`消費税 ${pct(r.tax)}`, YEN(t.tax), { cls: 'small' })}
          ${row('税込', YEN(t.withTax), { cls: 'small' })}
          ${row('端数調整（タップで入力）', (t.adjust < 0 ? '-￥' + Math.abs(t.adjust).toLocaleString('ja-JP') : YEN(t.adjust)), { cls: 'small adjust' })}
          <div class="bd-sep thick ${provisional ? 'warn' : ''}"></div>
          <div class="bd-total"><span class="lbl">${provisional ? '暫定の合計' : '御見積金額'}</span><span class="v">${YEN(t.final)}</span></div>
          ${provisional ? `<div style="font-size:11.5px;color:#8A560F;margin-top:6px">単価待ちの${pending}件は金額に入っていません</div>` : ''}
        </div>
        <div class="bd-card" style="padding:0 0 ${rateOpen ? '14px' : '0'}">
          <button class="acc-head" id="cf-rates">
            <span style="font-size:18px">⚙</span><span class="t">この見積だけ率を変える${est.ratesEdited ? '　<span style="color:var(--accent)">✎ 変更あり</span>' : ''}</span>
            <span style="color:var(--muted)">${rateOpen ? '▲' : '▼'}</span>
          </button>
          ${rateOpen ? `
            <div style="padding:0 16px">
              ${rateRow('材料費 上乗せ', 'material', r)}
              ${rateRow('諸経費', 'overhead', r)}
              <div class="rate-row"><span class="lb">法定福利費</span>
                <div class="rate-input" data-rate="welfare"><b>${pctN(r.welfare)}</b><span>%</span></div>
                <button class="toggle ${welfareOn ? 'on' : ''}" id="cf-welfare"><span class="knob"></span></button></div>
              ${rateRow('損料', 'depreciation', r)}
              <div style="font-size:11.5px;color:var(--muted2);margin-top:6px;line-height:1.6">
                変えるとこの見積だけに反映されます。会社の設定は変わりません。<br>
                行ごとの上乗せは作りません（値引きの記録が1か所に集まるように）</div>
            </div>` : ''}
        </div>
        ${!provisional && t.targetPrice ? `
          <div style="padding:14px 16px 18px;font-size:12px;color:var(--muted2)">
            ℹ 売上目標${pctN(r.targetMargin)}%から逆算すると <b class="num" style="color:var(--muted)">${YEN(t.targetPrice)}</b></div>` : ''}
      </div>
      <div class="bottom-bar">
        <button class="btn btn-primary btn-block" style="height:56px;font-size:18px" id="cf-order">🚚 発注依頼を出す</button>
        <button class="btn btn-block" style="margin-top:8px" id="cf-hyoshi">📄 見積書を作る${provisional ? '（概算）' : ''}</button>
        ${provisional
          ? `<div class="btn btn-block" style="margin-top:8px;background:#EEF0F3;border-color:#D9DEE4;color:#A9B3BD;cursor:default">🔒 Excelへ渡す</div>
             <div style="text-align:center;font-size:11.5px;color:#8A560F;margin-top:6px">単価が全部そろうと押せます／
               <span id="cf-approx" style="text-decoration:underline;cursor:pointer;font-weight:700">概算として出す</span></div>`
          : '<button class="btn btn-block" style="margin-top:8px" id="cf-excel">Excelへ渡す</button>'}
      </div>`;

    ov.el.querySelector('#cf-back').addEventListener('click', ov.close);
    ov.el.querySelector('#cf-rates').addEventListener('click', () => { rateOpen = !rateOpen; paint(); });
    ov.el.querySelector('.adjust')?.addEventListener('click', () =>
      openNumpad({
        title: '端数調整（マイナスは後で符号タップ）', value: Math.abs(est.adjust || 0), unit: '円', allowDecimal: false,
        onDone: async (n) => {
          if (n == null) return;
          const sign = await confirmDialog('この金額を「値引き（マイナス）」として入れますか?', 'マイナスで入れる');
          await updateEstimate(estId, { adjust: sign ? -n : n });
        },
      }));
    ov.el.querySelectorAll('[data-rate]').forEach((el) => el.addEventListener('click', () => {
      const key = el.dataset.rate;
      openNumpad({
        title: '率（%）', value: pctN(r[key]), unit: '%',
        onDone: async (n) => {
          if (n == null) return;
          if (n >= 100) { toast('100%以上は入れられません'); return; }
          if (n >= 1 && n < 2 && !(await confirmDialog(`${n}% で合っていますか?（${Math.round(n * 100)}%の間違いではありませんか?）`, 'この値でよい'))) return;
          await updateEstimate(estId, { rates: { ...est.rates, [key]: n / 100 }, ratesEdited: true });
        },
      });
    }));
    ov.el.querySelector('#cf-welfare')?.addEventListener('click', async () => {
      const next = !(est.welfareOn !== false);
      await updateDoc(doc(db, 'estimates', estId), {
        welfareOn: next,
        welfareLog: arrayUnion({ by: local.get('staff', ''), at: Timestamp.now(), on: next }),
      });
    });
    ov.el.querySelector('#cf-order')?.addEventListener('click', () => openOrderRequestDialog());
    ov.el.querySelector('#cf-excel')?.addEventListener('click', () => doExport(false));
    ov.el.querySelector('#cf-approx')?.addEventListener('click', async () => {
      if (await confirmDialog(`単価待ちが${pending}件あります。仮単価（無ければ0円）のまま概算として出しますか?`, '概算として出す')) doExport(true);
    });
    ov.el.querySelector('#cf-hyoshi')?.addEventListener('click', async () => {
      if (provisional) {
        if (!(await confirmDialog(`単価待ちが${pending}件あります。仮単価（無ければ0円）のまま「概算」と明記した見積書を作りますか?`, '概算として出す'))) return;
        openHyoshi(true);
      } else openHyoshi(false);
    });
  }

  // 見積書（表紙HTML hyoshi.html）を開く。データはURLの #app= に載せて渡す
  //（別タブ/別コンテキストでも確実に届くように。ストレージ共有には頼らない）
  function openHyoshi(approx) {
    const r = ratesOf(est), u = unitRatesOf(est);
    const t = calcAll(est, lines);
    const amt = (l) => excelRound(lineAmount(l, r, u) || 0);
    const by = (k) => lines.filter((l) => l.kind === k);
    const payload = {
      work: est.projectName || '', loc: est.site || '', client: est.customer || '',
      orderNo: est.orderNo || '', tanto: est.staff || '',
      welfareOn: est.welfareOn !== false, approx: !!approx,
      totals: {
        mat: t.material, lab: t.labor, mov: t.travel, subcon: t.subcontract,
        exp: t.overhead, wel: t.welfare, songa: t.depreciation,
        subtax: t.taxable, tax: t.tax, adjust: t.adjust, grand: t.final, taxPct: r.tax,
      },
      mat: by('材料').map((l) => ({
        nm: (l.name || '') + (l.pendingPrice ? (l.tempCost > 0 ? '（仮単価）' : '（単価未定）') : ''),
        qty: l.qty || 0, unit: l.unit || '', price: l.cost || 0, amt: amt(l),
      })),
      lab: by('労務').map((l) => ({ job: l.name || l.trade || '', ppl: l.persons || 0, hrs: l.hours || 0, rate: l.rate || 0, amt: amt(l) })),
      mov: by('移動').map((l) => ({ desc: l.name || '', ppl: l.persons || 0, hrs: l.hours || 0, km: l.km || 0, amt: amt(l) })),
      subcon: by('外注').map((l) => ({ vendor: l.supplier || '', content: l.name || '', amt: l.amount || 0 })),
    };
    // ?v= を付けて、端末に残った古い表紙HTMLが使われないようにする
    const url = 'hyoshi.html?v=8#app=' + encodeURIComponent(JSON.stringify(payload));
    const w = window.open(url, '_blank');
    if (!w) location.assign(url);
  }

  function doExport(approx) {
    const warnings = exportEstimateCsv(est, lines, ratesOf(est), unitRatesOf(est), { approx });
    if (warnings.length) toast('⚠ ' + warnings.join('／'));
    else toast('CSVを書き出しました。Excelの「アプリのCSVを読み込む」で取り込めます');
  }

  // 発注依頼: 納品場所と希望納期は必須（README第4章）
  function openOrderRequestDialog() {
    const PLACES = ['松前工場', '伊予工場', '東方加工場'];
    const root = document.getElementById('modal-root');
    const back = document.createElement('div');
    back.className = 'modal-back';
    let place = est.deliveryPlace || '';
    const paintDlg = () => {
      back.innerHTML = `
        <div class="modal"><div class="modal-head">発注依頼を出す</div>
        <div class="modal-body">
          <div class="field"><label>納品場所（必須）</label>
            <div class="chips" style="flex-wrap:wrap">
              ${PLACES.map((p) => `<div class="chip ${place === p ? 'on' : ''}" data-p="${p}" style="flex:none;min-width:31%">${p}</div>`).join('')}
            </div>
            <input class="input" id="or-place" style="margin-top:8px" placeholder="その他の場所は手打ち" value="${PLACES.includes(place) ? '' : esc(place)}"></div>
          <div class="field"><label>希望納期（必須）</label>
            <input class="input" type="date" id="or-due" value="${esc(est.dueDate || '')}"></div>
          <div style="display:flex;gap:8px">
            <button class="btn" style="flex:1" id="or-cancel">やめる</button>
            <button class="btn btn-primary" style="flex:1" id="or-ok">発注依頼を出す</button>
          </div>
        </div></div>`;
      back.querySelectorAll('[data-p]').forEach((c) => c.addEventListener('click', () => { place = c.dataset.p; paintDlg(); }));
      back.querySelector('#or-place').addEventListener('input', (e) => { place = e.target.value.trim(); });
      back.querySelector('#or-cancel').addEventListener('click', () => back.remove());
      back.querySelector('#or-ok').addEventListener('click', async () => {
        const due = back.querySelector('#or-due').value;
        if (!place) { toast('納品場所を選んでください'); return; }
        if (!due) { toast('希望納期を入れてください'); return; }
        try {
          await updateEstimate(estId, {
            status: '発注待ち', deliveryPlace: place, dueDate: due,
            orderRequestedAt: Timestamp.now(), orderStatus: est.orderStatus || {},
          });
          back.remove();
          toast('発注依頼を出しました。事務所の発注待ち一覧に載ります');
        } catch (e) { console.error(e); toast('保存できませんでした'); }
      });
    };
    paintDlg();
    root.appendChild(back);
  }

  function rateRow(lbl, key, r) {
    return `<div class="rate-row"><span class="lb">${lbl}</span>
      <div class="rate-input" data-rate="${key}"><b>${pctN(r[key])}</b><span>%</span></div></div>`;
  }

  function pct(v) { return pctN(v) + '%'; }
  function pctN(v) { return Math.round((v || 0) * 1000) / 10; }
}
