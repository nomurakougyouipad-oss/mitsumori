// ============================================================
// 明細の入力オーバーレイ — 材料（検索／手打ち／単価待ち）・労務・移動・外注
// 「入力は1件1ページ。保存して次へで画面は移動しない」（README第4章）
// ============================================================

import { esc, YEN, local } from './util.js?v=21';
import { icons } from './icons.js?v=21';
import { openOverlay, openNumpad, toast, bindSearch } from './ui.js?v=21';
import { cache, searchItems, isStale, addLine, updateLine, bumpUseCount, addNamed } from './store.js?v=21';
import { excelRound } from './calc.js?v=21';
import {
  buildCatalog, catalogKinds, catalogMaterials,
  fillPattern, makeName, shapeName, buildNameIndex, lookupName,
} from './catalog.js?v=21';

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
  const ov = openOverlay({ narrow: true });
  const recent = [];
  let selected = null;   // 選択中の品目（マスター）
  let qty = opts.prefill?.qty ?? 1;
  let editingLineId = opts.prefill?.lineId || null;

  if (opts.prefill?.itemId) {
    selected = cache.items.find((i) => i.id === opts.prefill.itemId) || null;
  }
  if (opts.prefill?.catalog) {
    // 規格から選んだ行は、同じ選び方の画面へ戻す
    ov.close();
    openCatalogPage(estimateId, est, opts);
    return;
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
            📐 マスターに無いものを規格から選んで入れる</span>
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
    body.querySelector('#m-manual').addEventListener('click', () => { ov.close(); openCatalogPage(estimateId, est, {}); });

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
// 規格から選んで入れる（種類 → 材質 → 寸法）
// 手打ちの品名は人によって書き方が割れ、単価マスターに同じ物が別名で溜まる。
// 選択式にして書き方を1つに決める。表記は単価マスターの実データに合わせる
//（詳細は catalog.js のコメント）。
// 単価はここでは入れない。マスターに同じ品名があればその単価を使い、
// 無ければ単価待ち（時計マーク）で事務所が業者に聞いて入れる。
// ============================================================
export function openCatalogPage(estimateId, est, opts = {}) {
  const ov = openOverlay({ narrow: true });
  const p = opts.prefill || {};
  const editingLineId = p.lineId || null;
  const recent = [];
  const cat = buildCatalog(cache.items);
  const nameIndex = buildNameIndex(cache.items);    // 品名→単価マスター（毎回1,567件なめない）

  let kindKey = '', matLabel = '', shapeKey = '', lenKey = '', picked = null;  // picked: {name, unit, cost, itemId}
  let composing = false, values = [];
  let qty = p.qty ?? 1;

  // 編集で開いたときは、品名から種類・材質を割り出して選択済みにしておく
  if (p.name) picked = { name: p.name, unit: p.unit || '', cost: p.cost ?? null, itemId: p.itemId || null };

  const group = () => {
    if (!kindKey || !matLabel) return null;
    return catalogMaterials(cat, kindKey).find((m) => m.label === matLabel) || null;
  };

  function pickSize(s) {
    picked = { name: s.name, unit: s.unit, cost: s.cost ?? null, itemId: s.id, supplier: s.supplier || '' };
    composing = false;
    paint();
  }

  // 一覧に無いサイズを、その種類×材質の書き方どおりに組み立てる
  function composedName() {
    const g = group();
    if (!g || !g.pattern) return '';
    return makeName(g.head, g.material, fillPattern(g.pattern, values));
  }
  function applyComposed() {
    const g = group();
    const name = composedName();
    if (!name || name.includes('?')) { toast('寸法をすべて入れてください'); return; }
    pickName(g, name);
  }

  // 組み立てた品名を選ぶ。同じ品名がマスターにあれば、その単価を使う（単価待ちにしない）
  function pickName(g, name) {
    const hit = lookupName(nameIndex, name);
    picked = hit
      ? { name: hit.name, unit: hit.unit || g.unit, cost: hit.cost ?? null, itemId: hit.id, supplier: hit.supplier || '' }
      : { name, unit: g.unit, cost: null, itemId: null, supplier: '' };
    composing = false;
    paint();
  }

  const shape = () => {
    const g = group();
    if (!g || !g.hasLength) return null;
    return g.shapes.find((s) => s.key === shapeKey) || null;
  };

  // マスターの品目をそのまま並べる（形×長さに割れない材質・変則表記用）
  function sizeListHtml(sizes) {
    if (!sizes.length) return '';
    return `<div style="border:1px solid var(--line);border-radius:6px;overflow:hidden;background:#fff">
      ${sizes.map((s) => `
        <div class="cand" data-size="${esc(s.id)}" style="border-top:1px solid #E6EAEE">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="nm" style="flex:1">${esc(s.dims)}${s.mods.length ? `<small style="color:var(--muted2)"> ${esc(s.mods.join('・'))}</small>` : ''}</span>
            <span class="num" style="font-weight:700;color:${num(s.cost) != null ? 'var(--navy)' : 'var(--accent)'}">
              ${num(s.cost) != null ? YEN(s.cost) : '単価待ち'}</span>
          </div>
        </div>`).join('')}
    </div>`;
  }

  // ③ 形（長さを除いた寸法）。過去に買った形を上に、JIS標準はその下にまとめる。
  // 形の一覧は長いので、選んだら畳んで④を見せる
  function shapeStepHtml(g) {
    const sel = shape();
    if (sel) return `
      <div class="field" style="margin-top:14px"><label>③ 形（${esc(g.head)}）</label>
        <div class="cand" style="border:1px solid var(--line);border-radius:6px;background:#EDF3FA">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="nm num" style="flex:1;font-weight:700">${esc(sel.label)}</span>
            <button class="btn" id="cg-reshape" style="min-height:44px;padding:0 14px">形を変える</button>
          </div>
        </div>
      </div>`;

    const mine = g.shapes.filter((s) => s.master.length);
    const jis = g.shapes.filter((s) => !s.master.length);
    const row = (s) => `
      <div class="cand" data-shape="${esc(s.key)}" style="border-top:1px solid #E6EAEE">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="nm num" style="flex:1;font-weight:600">${esc(s.label)}</span>
          <span style="font-size:11.5px;color:var(--muted2);text-align:right">
            ${s.master.length ? `買った実績 ${s.master.length}件` : 'JIS標準'}
            ${s.kgm != null ? `<br>${s.kgm}kg/m` : ''}</span>
        </div>
      </div>`;
    const box = (rows) => `<div style="border:1px solid var(--line);border-radius:6px;overflow:hidden;background:#fff;max-height:320px;overflow-y:auto">${rows}</div>`;
    return `
      <div class="field" style="margin-top:14px"><label>③ 形（${esc(g.head)}）</label>
        ${mine.length ? box(mine.map(row).join('')) : ''}
        ${jis.length ? `
          <div style="font-size:11.5px;color:var(--muted);margin:${mine.length ? '10px' : '0'} 0 4px">
            JIS標準サイズ（買った実績は無い形）</div>
          ${box(jis.map(row).join(''))}` : ''}
      </div>`;
  }

  // 形×長さでは出せないもの（変則表記）と、最後の手段の組み立て
  function otherStepHtml(g) {
    return `
      <div class="field" style="margin-top:14px">
        ${g.oddSizes && g.oddSizes.length ? `
          <label>書き方が違うもの</label>
          ${sizeListHtml(g.oddSizes)}` : ''}
        <button class="btn btn-block" id="cg-compose" style="margin-top:8px">＋ 一覧に無いサイズを組み立てる</button>
      </div>`;
  }

  // その形×長さで実在するマスター行（修飾付きの品名も拾える）
  const lenRows = (s, val) => (s && s.byLen && s.byLen.get(val)) || [];

  // ④ 長さ。実在する行があればその単価を、無ければ単価待ちと出す
  function lengthStepHtml(g) {
    const s = shape();
    if (!s) return '';
    return `
      <div class="field" style="margin-top:14px"><label>④ 長さ</label>
        <div class="chips" style="flex-wrap:wrap">
          ${g.lengths.map((L) => {
            const rows = lenRows(s, L.value);
            const hit = rows.length === 1 ? rows[0] : (rows.length ? null : lookupName(nameIndex, shapeName(g, s, L.value)));
            const on = lenKey === L.value;
            const sub = rows.length > 1 ? `${rows.length}件から選ぶ`
              : (hit && num(hit.cost) != null ? YEN(hit.cost) : '単価待ち');
            return `<div class="chip ${on ? 'on' : ''}" data-len="${esc(L.value)}"
              style="flex:none;display:block;text-align:center;line-height:1.35;padding:8px 12px">
              <b>${esc(L.label)}</b><br>
              <small style="color:${on ? 'inherit' : (hit || rows.length > 1 ? 'var(--navy)' : 'var(--accent)')}">
                ${esc(sub)}</small></div>`;
          }).join('')}
        </div>
        ${s.kgm != null ? `<div style="font-size:11.5px;color:var(--muted);margin-top:6px">
          参考重量 ${s.kgm}kg/m（JIS）。金額の計算には使っていません</div>` : ''}
      </div>
      ${lenPickHtml()}`;
  }

  // 同じ寸法でマスターに複数ある場合（引抜／No1 など修飾違い）は選ばせる。
  // 値段が違うので、こちらで勝手に決めない
  function lenPickHtml() {
    const s = shape();
    const rows = lenRows(s, lenKey);
    if (rows.length < 2) return '';
    return `<div class="field" style="margin-top:14px">
      <label>⑤ どれにしますか（同じ寸法で${rows.length}件あります）</label>
      ${sizeListHtml(rows)}</div>`;
  }

  function paint() {
    const kinds = catalogKinds(cat);
    const mats = kindKey ? catalogMaterials(cat, kindKey) : [];
    const g = group();
    const rate = est.rates?.material ?? cache.rates.material;
    const base = picked && num(picked.cost) != null ? qty * picked.cost : null;
    const amount = base != null ? base * (1 + rate) : null;
    const waiting = picked && num(picked.cost) == null;

    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <span class="ttl">${editingLineId ? '規格から選び直す' : '規格から選ぶ'}</span>
        <button class="icon-btn" id="cg-close">✕</button>
      </div></div>
      <div class="page-body"><div style="padding:14px 12px">

        <div class="field"><label>① 種類</label>
          <div class="chips" style="flex-wrap:wrap">
            ${kinds.map((k) => `<div class="chip ${kindKey === k.key ? 'on' : ''}" data-kind="${k.key}"
              style="flex:none">${esc(k.label)}</div>`).join('')}
          </div></div>

        ${kindKey ? `
          <div class="field" style="margin-top:14px"><label>② 材質</label>
            <div class="chips" style="flex-wrap:wrap">
              ${mats.map((m) => `<div class="chip ${matLabel === m.label ? 'on' : ''}" data-mat="${esc(m.label)}"
                style="flex:none">${esc(m.label)}<small style="color:var(--muted2);margin-left:4px">${m.sizes.length}</small></div>`).join('')}
            </div></div>` : ''}

        ${g && !composing && g.hasLength ? shapeStepHtml(g) + lengthStepHtml(g) + otherStepHtml(g) : ''}

        ${g && !composing && !g.hasLength ? `
          <div class="field" style="margin-top:14px"><label>③ 寸法（${esc(g.head)}）</label>
            ${sizeListHtml(g.sizes)}
            <button class="btn btn-block" id="cg-compose" style="margin-top:8px">＋ 一覧に無いサイズを組み立てる</button>
          </div>` : ''}

        ${g && composing ? `
          <div class="field" style="margin-top:14px"><label>③ 寸法を組み立てる</label>
            <div class="card">
              <div style="font-size:12px;color:var(--muted);line-height:1.7">
                この材質の書き方：<b class="num">${esc(g.pattern)}</b><br>
                例：${g.sizes.slice(0, 2).map((s) => esc(s.name)).join('<br>例：')}
              </div>
              <div class="qty-row" style="flex-wrap:wrap;margin-top:10px">
                ${values.map((v, i) => `
                  <div style="text-align:center">
                    <div style="font-size:11px;color:var(--muted);margin-bottom:2px">${esc(g.labels[i] || ('寸法' + (i + 1)))}</div>
                    <div class="qty-box" data-slot="${i}" style="min-width:74px"><b>${esc(String(v || '—'))}</b></div>
                  </div>`).join('')}
              </div>
              <div style="margin-top:12px;font-size:13px">できる品名：<b>${esc(composedName() || '—')}</b></div>
              <div style="display:flex;gap:8px;margin-top:10px">
                <button class="btn" style="flex:1" id="cg-cancel-compose">やめる</button>
                <button class="btn btn-primary" style="flex:1" id="cg-apply">この品名にする</button>
              </div>
            </div>
          </div>` : ''}

        ${picked ? `
          <div class="sel-card" style="margin-top:16px">
            <div class="head">✓ 選んだ品目</div>
            <div class="nm">${esc(picked.name)}</div>
            <div class="sub">${waiting
              ? '<span style="color:var(--accent);font-weight:700">⏱ 単価待ち</span>　事務所が業者に聞いて入れます'
              : `原価 <b>${YEN(picked.cost)}</b>／${esc(picked.unit || '本')}`}</div>
          </div>
          <div class="qty-row" style="margin-top:12px">
            <div class="qty-box" id="cg-qty"><b>${qty}</b><span>${esc(picked.unit || '本')}</span></div>
            ${[1, 5, 10].map((n) => `<button class="qty-plus" data-add="${n}">＋${n}</button>`).join('')}
          </div>
          ${amount != null ? `
            <div class="amount-band" style="margin-top:12px">
              <div><div class="lbl">原価計</div><div class="v" style="font-size:17px;color:#4A5A6B">${YEN(base)}</div></div>
              <div style="flex:1"></div>
              <div style="text-align:right"><div class="lbl">計上</div>
                <div class="v" style="font-size:26px;color:var(--navy)">${YEN(excelRound(amount))}</div></div>
            </div>` : `
            <div style="margin-top:12px;font-size:12.5px;color:#8A560F;line-height:1.7">
              単価が入るまで金額は出ません。見積は「暫定」の扱いになります。</div>`}
        ` : ''}

        <div style="padding:20px 0 8px;text-align:center">
          <span id="cg-free" style="font-size:13px;color:#4A5A6B;text-decoration:underline;text-underline-offset:3px;cursor:pointer">
            ✎ 一覧にどうしても無い → 自由入力で入れる</span>
        </div>
      </div></div>
      <div class="bottom-bar">
        ${recentBandHtml(recent)}
        <button class="btn btn-primary btn-block btn-big" id="cg-next" ${picked ? '' : 'disabled'}>
          ${editingLineId ? '保存して戻る' : '保存して次へ'}</button>
        ${editingLineId ? '' : `<button class="btn btn-block" id="cg-back" style="margin-top:8px" ${picked ? '' : 'disabled'}>保存して戻る</button>`}
      </div>`;

    ov.el.querySelector('#cg-close').addEventListener('click', ov.close);
    ov.el.querySelectorAll('[data-kind]').forEach((el) => el.addEventListener('click', () => {
      kindKey = el.dataset.kind; matLabel = ''; shapeKey = ''; lenKey = ''; composing = false; picked = null;
      const ms = catalogMaterials(cat, kindKey);
      if (ms.length === 1) matLabel = ms[0].label;   // 材質が1つなら選ばせない
      paint();
    }));
    ov.el.querySelectorAll('[data-mat]').forEach((el) => el.addEventListener('click', () => {
      matLabel = el.dataset.mat; shapeKey = ''; lenKey = ''; composing = false; picked = null; paint();
    }));
    ov.el.querySelectorAll('[data-shape]').forEach((el) => el.addEventListener('click', () => {
      shapeKey = el.dataset.shape; lenKey = ''; picked = null; paint();
    }));
    ov.el.querySelector('#cg-reshape')?.addEventListener('click', () => {
      shapeKey = ''; lenKey = ''; picked = null; paint();
    });
    ov.el.querySelectorAll('[data-len]').forEach((el) => el.addEventListener('click', () => {
      const g = group(), s = shape();
      if (!g || !s) return;
      lenKey = el.dataset.len;
      const rows = lenRows(s, lenKey);
      if (rows.length === 1) pickSize(rows[0]);          // 実在する行をそのまま使う
      else if (rows.length > 1) { picked = null; paint(); }  // 修飾違いが複数 → ⑤で選ばせる
      else pickName(g, shapeName(g, s, lenKey));         // 無ければ組み立てて単価待ち
    }));
    ov.el.querySelectorAll('[data-size]').forEach((el) => el.addEventListener('click', () => {
      const s = group().sizes.find((x) => x.id === el.dataset.size);
      if (s) pickSize(s);
    }));
    ov.el.querySelector('#cg-compose')?.addEventListener('click', () => {
      // 初期値は、その材質で実際に使われているサイズ（型と桁数が合うもの）
      values = (group().seedValues || []).slice();
      composing = true; paint();
    });
    ov.el.querySelectorAll('[data-slot]').forEach((el) => el.addEventListener('click', () => {
      const i = +el.dataset.slot;
      const gg = group();
      openNumpad({
        title: (gg.labels[i] || ('寸法' + (i + 1))) + '（よく使う値：' + (gg.slotValues[i] || []).slice(0, 8).join('・') + '）',
        value: values[i] ?? '', unit: 'mm',
        onDone: (n) => { if (n != null) { values[i] = String(n); paint(); } },
      });
    }));
    ov.el.querySelector('#cg-cancel-compose')?.addEventListener('click', () => { composing = false; paint(); });
    ov.el.querySelector('#cg-apply')?.addEventListener('click', applyComposed);
    ov.el.querySelector('#cg-qty')?.addEventListener('click', () =>
      openNumpad({ title: '数量', value: qty, unit: picked.unit || '本', onDone: (n) => { if (n != null) { qty = n; paint(); } } }));
    ov.el.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
      qty = (num(qty) || 0) + Number(b.dataset.add); paint();
    }));
    ov.el.querySelector('#cg-free').addEventListener('click', () => { ov.close(); openManualPage(estimateId, est, {}); });
    ov.el.querySelector('#cg-next')?.addEventListener('click', () => save(true));
    ov.el.querySelector('#cg-back')?.addEventListener('click', () => save(false));
  }

  async function save(stay) {
    if (!picked) return;
    const waiting = num(picked.cost) == null;
    const line = {
      kind: '材料', itemId: picked.itemId || null, name: picked.name,
      qty: num(qty) || 0, unit: picked.unit || '本',
      cost: num(picked.cost) || 0, supplier: picked.supplier || '',
      handwritten: false,
      pendingPrice: waiting,     // 単価が無いものは単価待ち（時計マーク）
      catalog: true,             // 規格から選んだ行（編集でまたこの画面に戻す目印）
    };
    try {
      if (editingLineId) {
        await updateLine(estimateId, editingLineId, line);
        ov.close();
        return;
      }
      await addLine(estimateId, { ...line, order: Date.now() });
      if (picked.itemId) bumpUseCount(picked.itemId);
      recent.push({ name: picked.name, qty: line.qty, unit: line.unit });
      if (stay) {
        toast(waiting ? '単価待ちで保存しました' : '保存しました。そのまま次を入れられます');
        picked = null; qty = 1; composing = false;
        paint();
      } else ov.close();
    } catch (e) { console.error(e); toast('保存できませんでした'); }
  }

  paint();
}

// ============================================================
// 手打ち行（✎）— 規格に無いもの・「◯◯工事 一式」も（最後の手段）
// ============================================================
export function openManualPage(estimateId, est, opts = {}) {
  const ov = openOverlay({ narrow: true });
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
  const ov = openOverlay({ narrow: true });
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
  const ov = openOverlay({ narrow: true });
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
  const ov = openOverlay({ narrow: true });
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
  const ov = openOverlay({ narrow: true });
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
