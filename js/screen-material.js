// ============================================================
// 明細の入力オーバーレイ — 材料（検索／手打ち／単価待ち）・労務・移動・外注
// 「入力は1件1ページ。保存して次へで画面は移動しない」（README第4章）
// ============================================================

import { esc, YEN, local } from './util.js?v=13';
import { icons } from './icons.js?v=13';
import { openOverlay, openNumpad, toast, bindSearch } from './ui.js?v=13';
import { cache, searchItems, isStale, addLine, updateLine, bumpUseCount, addNamed } from './store.js?v=13';
import { excelRound } from './calc.js?v=13';

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

// 直近入力の帯（3〜4行）
function recentBandHtml(recent) {
  if (!recent.length) return '';
  const parts = recent.slice(-4).map((r) =>
    `${esc(r.name.slice(0, 8))} <b>${r.qty ?? ''}</b>${esc(r.unit || '')}`);
  return `<div class="recent-band"><span class="lb">入力済み</span>${parts.join('<span class="sep">／</span>')}</div>`;
}

// ============================================================
// 材料を追加（検索 → 選択 → 数量）
// prefill: 複製・編集時の初期値 {lineId?, itemId, name, qty, unit, cost, supplier, handwritten}
// ============================================================
export function openMaterialPage(estimateId, est, opts = {}) {
  const ov = openOverlay();
  const recent = [];
  let selected = null;   // 選択中の品目（マスター）
  let qty = opts.prefill?.qty ?? 1;
  let editingLineId = opts.prefill?.lineId || null;

  if (opts.prefill?.itemId) {
    selected = cache.items.find((i) => i.id === opts.prefill.itemId) || null;
  }
  if (opts.prefill?.handwritten) {
    // 手打ち行の複製・編集は手打ちページへ
    ov.close();
    openManualPage(estimateId, est, opts);
    return;
  }
  if (opts.prefill?.pendingPrice) {
    ov.close();
    openPendingPage(estimateId, est, opts);
    return;
  }

  let query = '';

  // iPhone対策の要：検索inputと下部ボタンは一度だけ生成し、以後は絶対に作り直さない。
  // 入力のたびにinputをinnerHTMLで再生成すると、iOSはキーボードを既定（かな）で
  // 出し直す・IME変換中の文字が二重に入る・タップ中のボタンが消えて押せない、が起きる。
  // 再描画するのは候補リスト等の可変部分（#m-body）だけ。
  function renderShell() {
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <span class="ttl">${editingLineId ? '材料を直す' : '材料を追加'}</span>
        <button class="icon-btn" id="m-close">✕</button>
      </div></div>
      <div class="search-block">
        <div class="search-box">${icons.search}
          <input id="m-q" placeholder="アングル 65 のように部材と寸法で" value="${esc(query)}" autocomplete="off">
        </div>
        <div class="search-hint">ひらがな・カタカナ・全角半角は気にせず打てます</div>
      </div>
      <div class="page-body" id="m-body"></div>
      <div class="bottom-bar">
        <div id="m-recent"></div>
        <button class="btn btn-primary btn-block btn-big" id="m-next" disabled>
          ${editingLineId ? '保存して戻る' : '保存して次へ'}</button>
        ${editingLineId ? '' : '<button class="btn btn-block" id="m-back" style="margin-top:8px" disabled>保存して戻る</button>'}
      </div>`;

    // inputは再生成しないので、変換中でもフォーカスとIME状態はそのまま保たれる
    bindSearch(ov.el.querySelector('#m-q'), (v) => { query = v; paintBody(); });
    ov.el.querySelector('#m-close').addEventListener('click', ov.close);
    ov.el.querySelector('#m-next').addEventListener('click', () => save(true));
    ov.el.querySelector('#m-back')?.addEventListener('click', () => save(false));
  }

  function updateBottom() {
    const next = ov.el.querySelector('#m-next');
    const back = ov.el.querySelector('#m-back');
    if (next) next.disabled = !selected;
    if (back) back.disabled = !selected;
    const r = ov.el.querySelector('#m-recent');
    if (r) r.innerHTML = recentBandHtml(recent);
  }

  function paintBody() {
    const results = query || !selected ? searchItems(query, 20) : [];
    const rate = est.rates?.material ?? cache.rates.material;
    const base = selected && num(selected.cost) != null ? qty * selected.cost : null;
    const amount = base != null ? base * (1 + rate) : null;
    const body = ov.el.querySelector('#m-body');

    body.innerHTML = `
        ${selected ? `
          <div style="padding:14px 12px 0">
            <div class="sel-card">
              <div class="head">✓ 選んだ品目</div>
              <div class="nm">${esc(selected.name)}</div>
              <div class="sub">${esc(selected.supplier || '—')} ／ 原価 <b>${num(selected.cost) != null ? YEN(selected.cost) : '—'}</b>／${esc(selected.unit || '個')}</div>
            </div>
            <div class="qty-row" style="margin-top:12px">
              <div class="qty-box" id="m-qty"><b>${qty}</b><span>${esc(selected.unit || '個')}</span></div>
              ${[1, 5, 10].map((n) => `<button class="qty-plus" data-add="${n}">＋${n}</button>`).join('')}
            </div>
            <div class="amount-band" style="margin-top:12px">
              <div><div class="lbl">原価計</div><div class="v" style="font-size:17px;color:#4A5A6B">${base != null ? YEN(base) : '—'}</div></div>
              <div style="text-align:center"><div class="lbl">上乗せ</div><div class="v" style="font-size:15px;color:#4A5A6B">${Math.round(rate * 100)}%</div></div>
              <div style="flex:1"></div>
              <div style="text-align:right"><div class="lbl">計上</div><div class="v" style="font-size:26px;color:var(--navy)">${amount != null ? YEN(excelRound(amount)) : '—'}</div></div>
            </div>
          </div>` : ''}
        ${results.length ? `
          <div class="cand-head">候補 ${results.length}件${query ? '' : '（よく使う順）'}</div>
          <div style="border-bottom:1px solid #E6EAEE">
            ${results.map((it) => `
              <div class="cand ${selected && selected.id === it.id ? 'on' : ''}" data-id="${it.id}">
                <div style="display:flex;align-items:center">
                  <div style="flex:1;min-width:0">
                    <div class="nm">${esc(it.name)}</div>
                    <div class="sub">${esc(it.supplier || '—')} ／ ${esc(it.unit || '—')} ／ 原価 <b>${num(it.cost) != null ? YEN(it.cost) : '—'}</b></div>
                  </div>
                  ${isStale(it) ? '<span class="cand-badge stale">単価が古い</span>' : ((it.useCount || 0) > 3 ? '<span class="cand-badge">よく使う</span>' : '')}
                </div>
              </div>`).join('')}
          </div>` : (query ? '<div class="empty" style="padding:24px">見つかりませんでした</div>' : '')}
        <div style="padding:14px 0 4px;text-align:center">
          <span id="m-pending" style="font-size:13.5px;color:#4A5A6B;text-decoration:underline;text-underline-offset:3px;cursor:pointer">
            ⏱ 単価がわからない（あとで事務所が入れる）</span>
        </div>
        <div style="padding:6px 0 16px;text-align:center">
          <span id="m-manual" style="font-size:13.5px;color:#4A5A6B;text-decoration:underline;text-underline-offset:3px;cursor:pointer">
            ✎ マスターに無いものを手打ちで入れる</span>
        </div>`;

    // --- 可変部分のイベント（#m-body内だけ。検索inputと下部ボタンはrenderShellで配線済み） ---
    body.querySelectorAll('.cand').forEach((el) => el.addEventListener('click', () => {
      selected = cache.items.find((i) => i.id === el.dataset.id);
      query = '';
      const q = ov.el.querySelector('#m-q');
      q.value = '';
      paintBody();
    }));
    body.querySelector('#m-qty')?.addEventListener('click', () => {
      openNumpad({ title: '数量', value: qty, unit: selected.unit || '', onDone: (n) => { if (n != null) { qty = n; paintBody(); } } });
    });
    body.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
      qty = (num(qty) || 0) + Number(b.dataset.add); paintBody();
    }));
    body.querySelector('#m-pending').addEventListener('click', () => { ov.close(); openPendingPage(estimateId, est, {}); });
    body.querySelector('#m-manual').addEventListener('click', () => { ov.close(); openManualPage(estimateId, est, {}); });

    updateBottom();
  }

  async function save(stay) {
    if (!selected) return;
    const line = {
      kind: '材料', itemId: selected.id, name: selected.name,
      qty: num(qty) || 0, unit: selected.unit || '', cost: num(selected.cost) || 0,
      supplier: selected.supplier || '',
      handwritten: false, pendingPrice: false,
      order: editingLineId ? undefined : Date.now(),
    };
    try {
      if (editingLineId) {
        delete line.order;
        await updateLine(estimateId, editingLineId, line);
        ov.close();
        return;
      }
      await addLine(estimateId, { ...line });
      bumpUseCount(selected.id);
      recent.push({ name: selected.name, qty: line.qty, unit: line.unit });
      if (stay) {
        toast('保存しました。そのまま次を入れられます');
        selected = null; qty = 1; query = '';
        const q = ov.el.querySelector('#m-q');
        q.value = '';
        paintBody();
        q.focus();
      } else ov.close();
    } catch (e) { console.error(e); toast('保存できませんでした'); }
  }

  renderShell();
  paintBody();
  if (!opts.prefill) ov.el.querySelector('#m-q').focus();
}

// ============================================================
// 手打ち行（✎）— マスターに無いもの・「◯◯工事 一式」も
// ============================================================
export function openManualPage(estimateId, est, opts = {}) {
  const ov = openOverlay();
  const p = opts.prefill || {};
  let name = p.name || '', unit = p.unit || '式', qty = p.qty ?? 1, cost = p.cost ?? null;
  let registerToMaster = false;
  const editingLineId = p.lineId || null;
  const recent = [];

  function paint() {
    const rate = est.rates?.material ?? cache.rates.material;
    const amount = num(cost) != null ? qty * cost * (1 + rate) : null;
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <span class="ttl">✎ 手打ちで入れる</span>
        <button class="icon-btn" id="mn-close">✕</button>
      </div></div>
      <div class="page-body"><div class="form-page">
        <div class="field"><label>品名（「雑材一式」などもここ）</label>
          <input class="input" id="mn-name" value="${esc(name)}" placeholder="レーザー加工品 SUS304 t6 型切" autocomplete="off"></div>
        <div style="display:flex;gap:14px">
          <div class="field" style="flex:1"><label>数量</label>
            <div class="qty-box" id="mn-qty" style="width:100%"><b>${qty}</b><span>${esc(unit)}</span></div></div>
          <div class="field" style="width:110px"><label>単位</label>
            <input class="input" id="mn-unit" value="${esc(unit)}"></div>
        </div>
        <div class="field"><label>単価（原価）</label>
          <div class="qty-box" id="mn-cost" style="width:100%"><b>${num(cost) != null ? cost.toLocaleString('ja-JP') : '—'}</b><span>円</span></div></div>
        ${amount != null ? `<div class="amount-band"><div><div class="lbl">計上（上乗せ${Math.round(rate * 100)}%込み）</div>
          <div class="v" style="font-size:24px;color:var(--navy)">${YEN(excelRound(amount))}</div></div></div>` : ''}
        <div class="field" style="margin-top:16px">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
            <input type="checkbox" id="mn-reg" ${registerToMaster ? 'checked' : ''} style="width:18px;height:18px">
            単価マスターに登録する（繰り返し買う材料のときだけ）</label>
          <div style="font-size:11.5px;color:var(--muted2);margin-top:4px">加工品・一点物では押さないでください</div>
        </div>
      </div></div>
      <div class="bottom-bar">
        ${recentBandHtml(recent)}
        <button class="btn btn-primary btn-block btn-big" id="mn-next">${editingLineId ? '保存して戻る' : '保存して次へ'}</button>
        ${editingLineId ? '' : '<button class="btn btn-block" id="mn-back" style="margin-top:8px">保存して戻る</button>'}
      </div>`;

    ov.el.querySelector('#mn-close').addEventListener('click', ov.close);
    ov.el.querySelector('#mn-name').addEventListener('input', (e) => { name = e.target.value; });
    ov.el.querySelector('#mn-unit').addEventListener('input', (e) => { unit = e.target.value; });
    ov.el.querySelector('#mn-qty').addEventListener('click', () =>
      openNumpad({ title: '数量', value: qty, unit, onDone: (n) => { if (n != null) { qty = n; paint(); } } }));
    ov.el.querySelector('#mn-cost').addEventListener('click', () =>
      openNumpad({ title: '単価（原価）', value: cost ?? '', unit: '円', onDone: (n) => { if (n != null) { cost = n; paint(); } } }));
    ov.el.querySelector('#mn-reg').addEventListener('change', (e) => { registerToMaster = e.target.checked; });
    ov.el.querySelector('#mn-next').addEventListener('click', () => save(!editingLineId));
    ov.el.querySelector('#mn-back')?.addEventListener('click', () => save(false));
  }

  async function save(stay) {
    if (!name.trim()) { toast('品名を入れてください'); return; }
    const line = {
      kind: '材料', itemId: null, name: name.trim(),
      qty: num(qty) || 0, unit, cost: num(cost) || 0, supplier: p.supplier || '',
      handwritten: true, pendingPrice: false,
    };
    try {
      if (editingLineId) await updateLine(estimateId, editingLineId, line);
      else await addLine(estimateId, { ...line, order: Date.now() });
      if (registerToMaster && num(cost) != null) {
        await addNamed('items', {
          category: '', supplier: '', name: name.trim(), unit, cost: num(cost),
          material: '', spec: '', type: '', useCount: 1, aliases: [],
          effectiveDate: null, updatedAt: new Date(), updatedAtRaw: '', needsReview: false,
        });
        toast('単価マスターにも登録しました');
      }
      recent.push({ name, qty, unit });
      if (stay && !editingLineId) {
        name = ''; qty = 1; cost = null; registerToMaster = false;
        paint();
      } else ov.close();
    } catch (e) { console.error(e); toast('保存できませんでした'); }
  }

  paint();
}

// ============================================================
// 単価待ち（時計）— 選択式のfabSpec入力。現場は名前と条件だけ入れて先に進む
// ============================================================
const FAB = {
  materials: ['SUS304', 'SUS316', 'SS400', 'A5052'],
  finishes: ['No.1', '2B', 'HL', 'なし'],
  works: ['型切', '角切', '穴明'],
  vendors: ['小野建', '豫洲', '信栄'],
};

export function openPendingPage(estimateId, est, opts = {}) {
  const ov = openOverlay();
  const p = opts.prefill || {};
  const spec = {
    material: '', finish: '', thickness: null, w: null, h: null,
    works: [], vendor: '', ...(p.fabSpec || {}),
  };
  let name = p.name || '', qty = p.qty ?? 1, tempCost = p.tempCost ?? null;
  let tempOpen = tempCost != null;
  const editingLineId = p.lineId || null;

  function paint() {
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <span class="ttl" style="font-size:17px">単価がわからないものを入れる</span>
        <button class="icon-btn" id="pd-close">✕</button>
      </div></div>
      <div class="page-body" style="background:#fff">
        <div style="padding:12px 16px 4px" class="field"><label>品名</label>
          <input class="input" id="pd-name" value="${esc(name)}" placeholder="レーザー PL 型切" autocomplete="off"></div>
        <div style="padding:14px 16px 0" class="field"><label>材質</label>
          <div class="chips">${FAB.materials.map((m) => `<div class="chip ${spec.material === m ? 'on' : ''}" data-mat="${m}">${m}</div>`).join('')}</div></div>
        <div style="padding:14px 16px 0" class="field"><label>仕上</label>
          <div class="chips">${FAB.finishes.map((m) => `<div class="chip ${spec.finish === m ? 'on' : ''}" data-fin="${m}">${m}</div>`).join('')}</div></div>
        <div style="padding:14px 16px 0;display:flex;gap:14px">
          <div class="field"><label>板厚</label>
            <div class="qty-box" id="pd-thick" style="width:92px;height:52px"><b style="font-size:22px;line-height:48px">${spec.thickness ?? '—'}</b><span style="font-size:13px">mm</span></div></div>
          <div class="field" style="flex:1"><label>寸法（幅 × 長さ）</label>
            <div style="display:flex;align-items:center;gap:8px">
              <div class="qty-box" id="pd-w" style="flex:1;height:52px"><b style="font-size:22px;line-height:48px">${spec.w ?? '—'}</b></div>
              <span style="color:var(--muted)">×</span>
              <div class="qty-box" id="pd-h" style="flex:1;height:52px"><b style="font-size:22px;line-height:48px">${spec.h ?? '—'}</b><span style="font-size:13px">mm</span></div>
            </div></div>
        </div>
        <div style="padding:14px 16px 0" class="field"><label>加工 <span style="font-weight:400;color:var(--muted2)">いくつでも選べます</span></label>
          <div class="chips">${FAB.works.map((m) => `<div class="chip ${spec.works.includes(m) ? 'on' : ''}" data-work="${m}">${spec.works.includes(m) ? '✓ ' : ''}${m}</div>`).join('')}</div></div>
        <div style="padding:14px 16px 0" class="field"><label>数量</label>
          <div class="qty-row">
            <div class="qty-box" id="pd-qty" style="width:104px;height:56px"><b style="font-size:26px;line-height:52px">${qty}</b><span style="font-size:13px">枚</span></div>
            ${[1, 5].map((n) => `<button class="qty-plus" style="height:56px" data-add="${n}">＋${n}</button>`).join('')}
          </div></div>
        <div style="padding:14px 16px 0" class="field"><label>頼む先（現場のあなたが選ぶのが大事）</label>
          <div class="chips">${FAB.vendors.map((m) => `<div class="chip ${spec.vendor === m ? 'on' : ''}" data-ven="${m}">${m}</div>`).join('')}</div>
          <div style="font-size:11.5px;color:var(--muted2);margin-top:6px">事務所がここに問い合わせます</div></div>
        <div style="margin:16px 16px 0;padding:12px 14px;background:#F3F5F8;border-radius:6px">
          <div style="font-size:12px;font-weight:700;color:var(--muted)">過去の似た実績</div>
          <div style="font-size:13px;color:var(--muted);margin-top:6px;line-height:1.6">
            実績が溜まると、ここに似た加工品の金額の幅が出ます（集計表の読み込みで育ちます）</div>
        </div>
        <div style="padding:14px 16px 18px">
          <div id="pd-temp-head" style="display:flex;align-items:center;gap:6px;font-size:13px;color:#4A5A6B;cursor:pointer">
            ${tempOpen ? '▲' : '▼'} いま概算で出したい場合（仮単価を入れる）</div>
          ${tempOpen ? `
            <div style="margin-top:10px;display:flex;align-items:center;gap:8px">
              <div class="qty-box" id="pd-temp" style="width:130px;height:52px;border-width:1px;border-color:#B9C4CF">
                <b style="font-size:22px;line-height:48px">${tempCost != null ? '￥' + tempCost.toLocaleString('ja-JP') : '—'}</b></div>
              <span style="font-size:13px;color:var(--muted)">／枚</span>
            </div>
            <div style="font-size:11.5px;color:var(--muted2);margin-top:8px">あとで実際の金額と差が見えます</div>` : ''}
        </div>
      </div>
      <div class="bottom-bar">
        <button class="btn btn-primary btn-block" style="height:56px;font-size:18px" id="pd-save">⏱ 単価待ちで保存</button>
        <button class="btn btn-block" id="pd-next" style="margin-top:8px">保存して次へ</button>
      </div>`;

    ov.el.querySelector('#pd-close').addEventListener('click', ov.close);
    ov.el.querySelector('#pd-name').addEventListener('input', (e) => { name = e.target.value; });
    ov.el.querySelectorAll('[data-mat]').forEach((c) => c.addEventListener('click', () => { spec.material = c.dataset.mat; paint(); }));
    ov.el.querySelectorAll('[data-fin]').forEach((c) => c.addEventListener('click', () => { spec.finish = c.dataset.fin; paint(); }));
    ov.el.querySelectorAll('[data-ven]').forEach((c) => c.addEventListener('click', () => { spec.vendor = c.dataset.ven; paint(); }));
    ov.el.querySelectorAll('[data-work]').forEach((c) => c.addEventListener('click', () => {
      const w = c.dataset.work;
      spec.works = spec.works.includes(w) ? spec.works.filter((x) => x !== w) : [...spec.works, w];
      paint();
    }));
    const np = (sel, title, key, unit) => ov.el.querySelector(sel)?.addEventListener('click', () =>
      openNumpad({ title, value: spec[key] ?? '', unit, onDone: (n) => { spec[key] = n; paint(); } }));
    np('#pd-thick', '板厚', 'thickness', 'mm');
    np('#pd-w', '幅', 'w', 'mm');
    np('#pd-h', '長さ', 'h', 'mm');
    ov.el.querySelector('#pd-qty').addEventListener('click', () =>
      openNumpad({ title: '数量', value: qty, unit: '枚', onDone: (n) => { if (n != null) { qty = n; paint(); } } }));
    ov.el.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => { qty = (num(qty) || 0) + Number(b.dataset.add); paint(); }));
    ov.el.querySelector('#pd-temp-head').addEventListener('click', () => { tempOpen = !tempOpen; paint(); });
    ov.el.querySelector('#pd-temp')?.addEventListener('click', () =>
      openNumpad({ title: '仮単価', value: tempCost ?? '', unit: '円/枚', onDone: (n) => { tempCost = n; paint(); } }));
    ov.el.querySelector('#pd-save').addEventListener('click', () => save(false));
    ov.el.querySelector('#pd-next').addEventListener('click', () => save(true));
  }

  async function save(stay) {
    const autoName = name.trim() ||
      ['レーザー加工品', spec.material, spec.thickness ? `t${spec.thickness}` : '', spec.works.join('・')].filter(Boolean).join(' ');
    if (!autoName) { toast('品名か条件を入れてください'); return; }
    const line = {
      kind: '材料', itemId: null, name: autoName,
      qty: num(qty) || 0, unit: '枚', cost: num(tempCost) || 0,
      supplier: spec.vendor || '',
      handwritten: false, pendingPrice: true,
      tempCost: num(tempCost), fabSpec: { ...spec },
    };
    try {
      if (editingLineId) await updateLine(estimateId, editingLineId, line);
      else await addLine(estimateId, { ...line, order: Date.now() });
      if (stay && !editingLineId) {
        toast('単価待ちで保存しました');
        name = ''; qty = 1; tempCost = null; tempOpen = false;
        Object.assign(spec, { thickness: null, w: null, h: null, works: [] });
        paint();
      } else ov.close();
    } catch (e) { console.error(e); toast('保存できませんでした'); }
  }

  paint();
}

// ============================================================
// 労務を追加
// ============================================================
export function openLaborPage(estimateId, est, opts = {}) {
  const ov = openOverlay();
  const p = opts.prefill || {};
  const trades = cache.unitRates.trades || [];
  let trade = p.trade || local.get('lastTrade', '') || (trades[0]?.name ?? '');
  let persons = p.persons ?? 1, hours = p.hours ?? 1;
  const editingLineId = p.lineId || null;

  function rateOf(t) { return trades.find((x) => x.name === t)?.rate ?? 0; }

  function paint() {
    const rate = rateOf(trade);
    const base = (num(persons) || 0) * (num(hours) || 0) * rate;
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <span class="ttl">労務を${editingLineId ? '直す' : '追加'}</span>
        <button class="icon-btn" id="lb-close">✕</button>
      </div></div>
      <div class="page-body"><div class="form-page">
        <div class="field"><label>職種</label>
          <div class="chips" style="flex-wrap:wrap">${trades.map((t) => `
            <div class="chip ${trade === t.name ? 'on' : ''}" style="flex:none;min-width:31%;padding:0 10px" data-t="${esc(t.name)}">${esc(t.name)}</div>`).join('')}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:6px">1h単価 <b class="num">${YEN(rate)}</b>（自動）</div></div>
        <div style="display:flex;gap:14px">
          <div class="field" style="flex:1"><label>人数</label>
            <div class="qty-box" id="lb-p" style="width:100%"><b>${persons}</b><span>人</span></div></div>
          <div class="field" style="flex:1"><label>時間</label>
            <div class="qty-box" id="lb-h" style="width:100%"><b>${hours}</b><span>h</span></div></div>
        </div>
        <div class="qty-row">
          ${[0.5, 1, 8].map((n) => `<button class="qty-plus" style="height:48px" data-addh="${n}">時間＋${n}</button>`).join('')}
        </div>
        <div class="amount-band" style="margin-top:16px">
          <div><div class="lbl">原価計 = ${persons}人 × ${hours}h × ${rate.toLocaleString('ja-JP')}円</div>
          <div class="v" style="font-size:24px;color:var(--navy)">${YEN(excelRound(base))}</div></div></div>
      </div></div>
      <div class="bottom-bar">
        <button class="btn btn-primary btn-block btn-big" id="lb-next">${editingLineId ? '保存して戻る' : '保存して次へ'}</button>
        ${editingLineId ? '' : '<button class="btn btn-block" id="lb-back" style="margin-top:8px">保存して戻る</button>'}
      </div>`;

    ov.el.querySelector('#lb-close').addEventListener('click', ov.close);
    ov.el.querySelectorAll('[data-t]').forEach((c) => c.addEventListener('click', () => { trade = c.dataset.t; paint(); }));
    ov.el.querySelector('#lb-p').addEventListener('click', () =>
      openNumpad({ title: '人数', value: persons, unit: '人', onDone: (n) => { if (n != null) { persons = n; paint(); } } }));
    ov.el.querySelector('#lb-h').addEventListener('click', () =>
      openNumpad({ title: '時間', value: hours, unit: 'h', onDone: (n) => { if (n != null) { hours = n; paint(); } } }));
    ov.el.querySelectorAll('[data-addh]').forEach((b) => b.addEventListener('click', () => { hours = (num(hours) || 0) + Number(b.dataset.addh); paint(); }));
    ov.el.querySelector('#lb-next').addEventListener('click', () => save(!editingLineId));
    ov.el.querySelector('#lb-back')?.addEventListener('click', () => save(false));
  }

  async function save(stay) {
    const line = {
      kind: '労務', name: trade, trade,
      persons: num(persons) || 0, hours: num(hours) || 0, rate: rateOf(trade),
      handwritten: false, pendingPrice: false,
    };
    local.set('lastTrade', trade);
    try {
      if (editingLineId) await updateLine(estimateId, editingLineId, line);
      else await addLine(estimateId, { ...line, order: Date.now() });
      if (stay && !editingLineId) { toast('保存しました'); paint(); }
      else ov.close();
    } catch (e) { console.error(e); toast('保存できませんでした'); }
  }

  paint();
}

// ============================================================
// 移動を追加（人数×時間×移動1h単価 ＋ 距離×2(往復)×km単価）
// ============================================================
export function openTravelPage(estimateId, est, opts = {}) {
  const ov = openOverlay();
  const p = opts.prefill || {};
  let name = p.name || '', persons = p.persons ?? 1, hours = p.hours ?? 0.5, km = p.km ?? null;
  const editingLineId = p.lineId || null;
  const u = { travelLabor: est.unitRates?.travelLabor ?? cache.unitRates.travelLabor, kmRate: est.unitRates?.kmRate ?? cache.unitRates.kmRate };

  function paint() {
    const laborPart = excelRound((num(persons) || 0) * (num(hours) || 0) * u.travelLabor);
    const kmPart = num(km) != null ? excelRound(km * 2 * u.kmRate) : 0;
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <span class="ttl">現場移動を${editingLineId ? '直す' : '追加'}</span>
        <button class="icon-btn" id="tv-close">✕</button>
      </div></div>
      <div class="page-body"><div class="form-page">
        <div class="field"><label>作業内容（省略可）</label>
          <input class="input" id="tv-name" value="${esc(name)}" placeholder="現場往復" autocomplete="off"></div>
        <div style="display:flex;gap:14px">
          <div class="field" style="flex:1"><label>人数</label>
            <div class="qty-box" id="tv-p" style="width:100%"><b>${persons}</b><span>人</span></div></div>
          <div class="field" style="flex:1"><label>移動時間</label>
            <div class="qty-box" id="tv-h" style="width:100%"><b>${hours}</b><span>h</span></div></div>
        </div>
        <div class="field"><label>距離（片道km・往復は自動で×2）</label>
          <div class="qty-box" id="tv-km" style="width:100%"><b>${km ?? '—'}</b><span>km</span></div></div>
        <div class="amount-band">
          <div><div class="lbl">移動労務 ${YEN(laborPart)} ＋ 車両 ${YEN(kmPart)}</div>
          <div class="v" style="font-size:24px;color:var(--navy)">${YEN(laborPart + kmPart)}</div></div></div>
      </div></div>
      <div class="bottom-bar">
        <button class="btn btn-primary btn-block btn-big" id="tv-next">保存して戻る</button>
      </div>`;

    ov.el.querySelector('#tv-close').addEventListener('click', ov.close);
    ov.el.querySelector('#tv-name').addEventListener('input', (e) => { name = e.target.value; });
    ov.el.querySelector('#tv-p').addEventListener('click', () =>
      openNumpad({ title: '人数', value: persons, unit: '人', onDone: (n) => { if (n != null) { persons = n; paint(); } } }));
    ov.el.querySelector('#tv-h').addEventListener('click', () =>
      openNumpad({ title: '移動時間', value: hours, unit: 'h', onDone: (n) => { if (n != null) { hours = n; paint(); } } }));
    ov.el.querySelector('#tv-km').addEventListener('click', () =>
      openNumpad({ title: '距離（片道）', value: km ?? '', unit: 'km', onDone: (n) => { km = n; paint(); } }));
    ov.el.querySelector('#tv-next').addEventListener('click', save);
  }

  async function save() {
    const line = {
      kind: '移動', name: name.trim() || '現場移動',
      persons: num(persons) || 0, hours: num(hours) || 0,
      handwritten: false, pendingPrice: false,
    };
    if (num(km) != null) line.km = num(km);
    try {
      if (editingLineId) await updateLine(estimateId, editingLineId, line);
      else await addLine(estimateId, { ...line, order: Date.now() });
      ov.close();
    } catch (e) { console.error(e); toast('保存できませんでした'); }
  }

  paint();
}

// ============================================================
// 外注を追加（完全に自由入力。今のExcelと同じ）
// ============================================================
export function openSubcontractPage(estimateId, est, opts = {}) {
  const ov = openOverlay();
  const p = opts.prefill || {};
  let supplier = p.supplier || '', content = p.name || '', amount = p.amount ?? null;
  const editingLineId = p.lineId || null;

  function paint() {
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <span class="ttl">外注を${editingLineId ? '直す' : '追加'}</span>
        <button class="icon-btn" id="sc-close">✕</button>
      </div></div>
      <div class="page-body"><div class="form-page">
        <div class="field"><label>外注先</label>
          <input class="input" id="sc-sup" value="${esc(supplier)}" list="sc-suppliers" autocomplete="off">
          <datalist id="sc-suppliers">${cache.suppliers.map((s) => `<option value="${esc(s.name)}">`).join('')}</datalist></div>
        <div class="field"><label>工事内容（規格・仕様等）</label>
          <input class="input" id="sc-con" value="${esc(content)}" autocomplete="off"></div>
        <div class="field"><label>金額</label>
          <div class="qty-box" id="sc-amt" style="width:100%"><b>${amount != null ? '￥' + amount.toLocaleString('ja-JP') : '—'}</b></div></div>
      </div></div>
      <div class="bottom-bar">
        <button class="btn btn-primary btn-block btn-big" id="sc-next">保存して戻る</button>
      </div>`;

    ov.el.querySelector('#sc-close').addEventListener('click', ov.close);
    ov.el.querySelector('#sc-sup').addEventListener('input', (e) => { supplier = e.target.value; });
    ov.el.querySelector('#sc-con').addEventListener('input', (e) => { content = e.target.value; });
    ov.el.querySelector('#sc-amt').addEventListener('click', () =>
      openNumpad({ title: '金額', value: amount ?? '', unit: '円', onDone: (n) => { amount = n; paint(); } }));
    ov.el.querySelector('#sc-next').addEventListener('click', save);
  }

  async function save() {
    if (num(amount) == null) { toast('金額を入れてください'); return; }
    const line = {
      kind: '外注', name: content.trim(), supplier: supplier.trim(),
      amount: num(amount),
      handwritten: false, pendingPrice: false,
    };
    try {
      if (editingLineId) await updateLine(estimateId, editingLineId, line);
      else await addLine(estimateId, { ...line, order: Date.now() });
      ov.close();
    } catch (e) { console.error(e); toast('保存できませんでした'); }
  }

  paint();
}
