// ============================================================
// 写真から見積（画面1）— AIがまだ無い版
//
// 【いまできること】
//   写真を撮って貼る（あとでAIが読む。今は残すだけ）
//   すること を一言だけ打つ
//   工事の種類を押す → ひな形から項目が並ぶ
//   人工（人数×時間）を直す → その場で金額と提出価格の幅が動く
//   分からない材料は「単価待ち」で置いたまま先へ進める
//
// 【AIが入ったら変わるところ】
//   ・rough-generate.js の generateItems() が ひな形 から AI に切り替わる
//   ・AIが出した項目は state:'未確定' で入るので、
//     「この金額を使う／金額を直す／単価待ちにする」の3択カードが出る（下の itemCard 参照）
//   ・ききたいこと（山吹の枠）が questions に入って出る
//   この画面はそのどちらも描けるように作ってある。AI側を実装しても画面は直さない。
// ============================================================

import { esc, YEN, local } from './util.js?v=33';
import { icons } from './icons.js?v=33';
import { openOverlay, openNumpad, openTextInput, toast, confirmDialog, setHtmlKeepScroll } from './ui.js?v=33';
import { cache } from './store.js?v=33';
import {
  WORK_TYPES, ITEM_KINDS, tradeRate, itemAmount, itemCandidates,
  yotsubaAmount, marketAmount, roughTotals, priceBand, counts, DISCLAIMER,
} from './rough-calc.js?v=33';
import {
  subscribeRough, subscribeRoughItems, subscribeRoughQuestions,
  effectiveRates, optionsFor, updateRough, addItems, updateItem, deleteItem,
  addItem, decideItem, overrideItemAmount, markPending, clearDecision,
  uploadPhoto, removePhoto, saveRoughSummary, freezeRough, addQuestion, answerQuestion,
} from './rough-store.js?v=33';
import { generateItems, isAiAvailable } from './rough-generate.js?v=33';
import { TEMPLATE_LABELS, templateRowCount } from './rough-templates.js?v=33';

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

// ============================================================
// 画面本体
// ============================================================
export function renderRoughScreen(container, roughId) {
  let rough = null;
  let items = [];
  let questions = [];
  let busy = false;
  let lastSig = '';

  const stops = [
    subscribeRough(roughId, (r) => {
      if (!r) { toast('概算が見つかりません'); location.hash = '#estimates'; return; }
      rough = r; paint();
    }),
    subscribeRoughItems(roughId, (list) => { items = list; paint(); pushSummary(); }),
    subscribeRoughQuestions(roughId, (list) => { questions = list; paint(); }),
  ];

  function calcAll() {
    const { rates, unitRates } = effectiveRates(rough);
    const opts = optionsFor(rough);
    return {
      rates, unitRates, opts,
      t: roughTotals(items, rates, unitRates, opts),
      band: priceBand(items, rates, unitRates, opts),
      c: counts(items),
    };
  }

  // 件数と金額を見積ドキュメントに写す（一覧が明細を読まずに済むように）
  async function pushSummary() {
    if (!rough) return;
    const { t, c } = calcAll();
    const sig = `${c.items}|${c.pending}|${Math.round(t.withTax)}`;
    if (sig === lastSig) return;
    lastSig = sig;
    try { await saveRoughSummary(roughId, rough, items); } catch (e) { console.warn(e); }
  }

  // ---------- 写真 ----------
  function photosHtml() {
    const list = rough.photos || [];
    const site = list.filter((p) => p.role !== '図面');
    const plans = list.filter((p) => p.role === '図面');
    const thumb = (p) => `
      <div class="ph-wrap" data-ph="${esc(p.path)}" style="position:relative">
        <img class="ph" src="${esc(p.url)}" alt="">
        ${p.role !== '現場' ? `<span style="position:absolute;left:4px;bottom:4px;background:rgba(27,58,92,.85);
          color:#fff;font-size:10px;padding:1px 5px;border-radius:3px">${esc(p.role)}</span>` : ''}
      </div>`;
    return `
      <div style="padding:12px 12px 0">
        <div class="photo-grid">
          ${site.map(thumb).join('')}
          <button class="ph-add" id="ph-site">${icons.plus}<span style="font-size:11px">写真</span></button>
        </div>
        <div style="font-size:11.5px;color:var(--muted2);padding:6px 2px 0">
          現場の写真 ${site.length}枚${isAiAvailable() ? '' : '（いまは残すだけ。AIが入ったら読み取ります）'}</div>
        <div style="display:flex;align-items:center;gap:8px;padding:10px 0 0">
          <span style="font-size:13px;font-weight:700;color:var(--navy);flex:none">図面</span>
          ${plans.map(thumb).join('')}
          <button class="ph-add" id="ph-plan" style="width:64px;height:64px">${icons.plus}<span style="font-size:10px">紙を撮る</span></button>
        </div>
      </div>`;
  }

  // ---------- すること ----------
  function oneLinerHtml() {
    return `
      <div style="padding:14px 12px 0">
        <div style="font-size:13px;font-weight:700;color:var(--navy);padding-bottom:6px">すること</div>
        <button id="r-oneliner" style="width:100%;min-height:52px;background:#fff;border:1px solid var(--line);
          border-radius:6px;display:flex;align-items:center;justify-content:space-between;gap:8px;
          padding:8px 12px 8px 14px;font-size:16px;font-family:var(--font);cursor:pointer;text-align:left;
          color:${rough.oneLiner ? 'var(--text)' : 'var(--muted2)'}">
          <span style="flex:1;min-width:0;line-height:1.5">${esc(rough.oneLiner || 'ポンプの駆動部を全部やりかえ')}</span>
          <span style="color:var(--muted2);flex:none">✎</span>
        </button>
        <div style="font-size:11.5px;color:var(--muted2);padding:6px 2px 0">打つのはここだけです。あとは全部ボタン。</div>
      </div>`;
  }

  // ---------- 工事の種類・項目を出す ----------
  function generateHtml() {
    const has = items.length > 0;
    return `
      <div style="padding:14px 12px 0">
        <div style="font-size:13px;font-weight:700;color:var(--navy);padding-bottom:6px">工事の種類</div>
        <div class="chips" style="flex-wrap:wrap;gap:8px">
          ${WORK_TYPES.map((w) => `
            <div class="chip ${rough.workType === w ? 'on' : ''}" data-wt="${esc(w)}"
              style="min-height:44px;display:flex;align-items:center">${esc(TEMPLATE_LABELS[w] || w)}</div>`).join('')}
        </div>
        <button class="btn btn-primary btn-block" id="r-gen" style="height:56px;margin-top:12px" ${busy ? 'disabled' : ''}>
          ${icons.search}${has ? '項目を出しなおす' : '項目を出す'}</button>
        <div style="font-size:11.5px;color:var(--muted2);text-align:center;padding-top:8px;line-height:1.6">
          ${isAiAvailable()
            ? '押すと写真から項目を並べます。金額はあとから一つずつ直せます。'
            : `押すと ${esc(TEMPLATE_LABELS[rough.workType] || rough.workType)} のひな形から
               ${templateRowCount(rough.workType)}項目が並びます。<br>要らない行は消して、人数と時間を直してください。`}
        </div>
      </div>`;
  }

  // ---------- ききたいこと（AIが入ったら出る） ----------
  function questionHtml(q) {
    const opts = (q.options || []).length ? q.options : ['要る', '要らない'];
    if (q.answer) return '';
    return `
      <div style="background:#FBF2E4;border:1.5px solid var(--accent);border-radius:6px;padding:12px 14px">
        <div style="display:flex;align-items:center;gap:6px;color:var(--accent);font-size:12px;font-weight:700">
          ${icons.warning}ききたいこと</div>
        ${q.about ? `<div style="font-size:16px;font-weight:700;color:var(--text);padding-top:6px">${esc(q.about)}</div>` : ''}
        <div style="font-size:14px;color:#4A5A6B;line-height:1.55;padding-top:4px">${esc(q.text)}</div>
        <div style="display:flex;gap:8px;padding-top:10px">
          ${opts.map((o, i) => `
            <button class="btn ${i === 0 ? 'btn-primary' : ''}" style="flex:1;height:48px"
              data-ans="${q.id}" data-ansv="${esc(o)}">${esc(o)}</button>`).join('')}
        </div>
      </div>`;
  }

  // ---------- 項目カード ----------
  function itemCard(it, rates, unitRates) {
    const amt = itemAmount(it, rates, unitRates);
    const pending = it.state === '単価待ち';
    const undecided = it.state === '未確定';

    // 未確定（AIが出したもの）… よつばの単価と相場を2つ並べて、押させる
    if (undecided) {
      const y = yotsubaAmount(it, rates, unitRates);
      const m = marketAmount(it);
      return `
        <div class="card" style="border-style:dashed">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <div class="ttl" style="font-size:16px">${esc(it.name || '（名前なし）')}</div>
            <span style="font-size:11px;font-weight:700;color:#7A8794;border:1px solid var(--line2);
              border-radius:3px;padding:2px 6px;flex:none">未確定</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;padding-top:8px;font-size:13px;color:var(--muted)">
            <span>よつばの単価</span><span class="num">${y == null ? 'なし' : YEN(y)}</span></div>
          <div style="display:flex;align-items:center;justify-content:space-between;padding-top:4px;font-size:13px;color:var(--muted)">
            <span>世の中の相場</span>
            <span class="num" style="font-size:20px;font-weight:700;color:#1F6B5B">${m == null ? '—' : YEN(m)}</span></div>
          <div style="display:flex;gap:6px;padding-top:10px">
            ${y != null ? `<button class="btn btn-primary btn-sm" style="flex:1.2;height:48px" data-use="${it.id}" data-src="yotsuba">よつばで使う</button>` : ''}
            ${m != null ? `<button class="btn btn-primary btn-sm" style="flex:1.2;height:48px" data-use="${it.id}" data-src="market">この金額を使う</button>` : ''}
            <button class="btn btn-sm" style="flex:1;height:48px" data-edit="${it.id}">金額を直す</button>
            <button class="btn btn-sm" style="flex:1;height:48px" data-pend="${it.id}">単価待ち</button>
          </div>
          <div style="font-size:11.5px;color:var(--muted2);padding-top:8px">どれか押すまで合計に入りません</div>
        </div>`;
    }

    // 労務・移動 … 人数×時間を その場で増減
    if (it.kind === '労務' || it.kind === '移動') {
      const rate = it.kind === '移動'
        ? unitRates.travelLabor
        : (num(it.rate) ?? tradeRate(unitRates, it.trade));
      // 作業は1日（8h）単位で動かす。移動は1時間単位（往復1〜2時間のことが多い）
      const step = it.kind === '移動' ? 1 : 8;
      return `
        <div class="card">
          <div style="display:flex;align-items:flex-start;gap:8px">
            <div class="ttl" style="font-size:16px;flex:1">${esc(it.name || '（名前なし）')}</div>
            <button class="btn btn-sm" style="flex:none;min-width:44px" data-del="${it.id}">✕</button>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:8px">
            <div style="font-size:13px;color:#4A5A6B">
              ${esc(it.kind === '移動' ? '移動労務' : (it.trade || ''))}
              <b class="num" data-np="${it.id}" style="cursor:pointer;text-decoration:underline">${it.persons ?? 0}</b>人 ×
              <b class="num" data-nh="${it.id}" style="cursor:pointer;text-decoration:underline">${it.hours ?? 0}</b>h
              ${rate ? `<span style="color:var(--muted2)">／ ${rate.toLocaleString('ja-JP')}円/h</span>` : ''}
            </div>
            <div style="display:flex;gap:6px;flex:none">
              <button class="btn btn-sm" style="width:56px;height:44px" data-h="${it.id}" data-d="-${step}">−${step}h</button>
              <button class="btn btn-sm" style="width:56px;height:44px" data-h="${it.id}" data-d="${step}">＋${step}h</button>
            </div>
          </div>
          ${it.kind === '移動' ? `
            <div style="display:flex;align-items:center;justify-content:space-between;padding-top:8px;font-size:13px;color:#4A5A6B">
              <span>片道 <b class="num" data-km="${it.id}" style="cursor:pointer;text-decoration:underline">${it.km ?? '—'}</b> km
                <span style="color:var(--muted2)">（往復で計算・${unitRates.kmRate}円/km）</span></span>
            </div>` : ''}
          <div style="display:flex;align-items:flex-end;justify-content:flex-end;padding-top:6px">
            <span class="num" style="font-size:26px;font-weight:700;color:var(--navy)">${YEN(amt || 0)}</span></div>
        </div>`;
    }

    // 材料・外注
    return `
      <div class="card" ${pending ? 'style="border-left:4px solid var(--accent)"' : ''}>
        <div style="display:flex;align-items:flex-start;gap:8px">
          <div class="ttl" style="font-size:16px;flex:1">${esc(it.name || '（名前なし）')}</div>
          ${pending ? `<span style="display:flex;align-items:center;gap:3px;font-size:11px;font-weight:700;color:#fff;
            background:var(--accent);border-radius:3px;padding:3px 6px;flex:none">${icons.clock}単価待ち</span>` : ''}
          <button class="btn btn-sm" style="flex:none;min-width:44px" data-del="${it.id}">✕</button>
        </div>
        ${pending ? `<div style="font-size:13px;color:var(--muted);padding-top:6px;line-height:1.6">
          仕入先に単価を聞いてから入れます。この1件を空けたまま先へ進めます。</div>` : ''}
        <div style="display:flex;align-items:flex-end;justify-content:space-between;padding-top:8px">
          <button class="btn btn-sm" style="height:44px" data-edit="${it.id}">${pending ? '金額を入れる' : '金額を直す'}</button>
          <span class="num" style="font-size:26px;font-weight:700;color:${pending ? 'var(--muted2)' : 'var(--navy)'}">
            ${pending ? '￥—' : YEN(amt || 0)}</span>
        </div>
      </div>`;
  }

  // ---------- 下の帯 ----------
  function bandHtml(band, c) {
    const note = c.undecided
      ? `<div style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:#F0C888;padding-top:8px">
           ${icons.warning}まだ決めていない項目が ${c.undecided} 件あります</div>`
      : c.pending
        ? `<div style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:#F0C888;padding-top:8px">
             ${icons.clock}単価待ちが ${c.pending} 件あります</div>`
        : '<div style="font-size:11.5px;color:rgba(255,255,255,.68);padding-top:8px">概算です。本見積は現地確認のあとに出します</div>';

    return `
      <div style="flex:none;background:var(--navy);padding:12px 14px calc(14px + env(safe-area-inset-bottom, 0px))">
        <div style="font-size:11.5px;color:rgba(255,255,255,.68)">提出価格の目安（税込）</div>
        <div class="num" style="font-size:28px;font-weight:700;color:${band.hasAmount ? '#fff' : 'rgba(255,255,255,.34)'};
          letter-spacing:-.01em;padding-top:2px">
          ${band.hasAmount ? `${YEN(band.displayLow)} 〜 ${YEN(band.displayHigh)}` : '￥— 〜 ￥—'}</div>
        ${note}
        <div style="display:flex;gap:8px;padding-top:10px">
          <button class="btn btn-sm" id="r-add" style="flex:1;height:48px;background:rgba(255,255,255,.14);
            border-color:rgba(255,255,255,.4);color:#fff;font-size:16px">項目を足す</button>
          <button class="btn btn-sm" id="r-save" style="flex:1;height:48px;background:#fff;color:var(--navy);
            border-color:#fff;font-size:16px" ${band.hasAmount ? '' : 'disabled'}>この金額で残す</button>
        </div>
      </div>`;
  }

  // ---------- 描画 ----------
  function paint() {
    if (!rough) return;
    const { rates, unitRates, band, c } = calcAll();
    const open = questions.filter((q) => !q.answer);

    const body = items.length
      ? `<div style="display:flex;align-items:center;gap:8px;padding:16px 14px 8px">
           <span style="font-size:13px;font-weight:700;color:var(--navy)">項目</span>
           <span class="num" style="font-size:13px;font-weight:700;color:#7A8794">${c.items}件</span>
           <span style="flex:1;height:1px;background:var(--line2)"></span>
           ${c.undecided ? `<span style="font-size:11.5px;color:var(--accent);font-weight:700">未確定 ${c.undecided}</span>`
             : `<span style="display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--green);font-weight:700">
                  ${icons.checkCircle}${c.decided}件 確定</span>`}
         </div>
         <div style="display:flex;flex-direction:column;gap:8px;padding:0 12px">
           ${open.map(questionHtml).join('')}
           ${items.map((it) => itemCard(it, rates, unitRates)).join('')}
         </div>
         <div style="height:12px"></div>`
      : `<div class="empty" style="padding:36px 24px">
           <div class="big">項目はまだありません</div>
           上の「項目を出す」を押してください</div>`;

    setHtmlKeepScroll(container, `
      <div class="screen">
        <div class="est-header" style="padding-top: env(safe-area-inset-top, 0px)">
          <div class="row1">
            <button class="icon-btn" id="r-back" style="color:#fff;background:none;border:0;width:44px;height:44px;font-size:24px;cursor:pointer">←</button>
            <div style="flex:1;min-width:0">
              <div class="ttl">${esc(rough.projectName || '（工事名なし）')}</div>
              <div class="meta">概算${rough.customer ? ' ／ ' + esc(rough.customer) : ''}</div>
              <div class="saved">☁ 自動保存されます</div>
            </div>
          </div>
        </div>
        <button class="cover-row" id="r-cover">
          <span class="main">表紙の情報</span>
          <span class="sub">${esc([rough.projectName, rough.customer, rough.site].filter(Boolean).join('・') || '工事名・宛先・施工場所')}</span>
          <span style="color:var(--muted)">›</span>
        </button>
        <div class="scroll est-list-scroll" style="padding:0">
          ${photosHtml()}
          ${oneLinerHtml()}
          ${generateHtml()}
          ${body}
        </div>
        ${bandHtml(band, c)}
      </div>`);

    bind();
  }

  // ---------- 操作 ----------
  function bind() {
    const q = (s) => container.querySelector(s);
    const all = (s) => container.querySelectorAll(s);

    q('#r-back').addEventListener('click', () => { location.hash = '#estimates'; });
    q('#r-cover').addEventListener('click', () => openRoughCover(roughId, () => rough));

    q('#ph-site').addEventListener('click', () => pickPhoto('現場'));
    q('#ph-plan').addEventListener('click', () => pickPhoto('図面'));
    // 写真は押したら「大きく見る」。消すのは その中のボタンから。
    // 見たいだけで押した人に、いきなり削除を聞かない。
    all('[data-ph]').forEach((el) => el.addEventListener('click', () => {
      const p = (rough.photos || []).find((x) => x.path === el.dataset.ph);
      if (p) viewPhoto(p);
    }));

    q('#r-oneliner').addEventListener('click', () => {
      openTextInput({
        title: 'すること', value: rough.oneLiner || '', multiline: true,
        placeholder: '例）ポンプの駆動部を全部やりかえ',
        hint: '一言で構いません。AIが入ったら、この言葉と写真から項目を出します。',
        onDone: (v) => { if (v != null) updateRough(roughId, { oneLiner: v }).catch(() => toast('保存できませんでした')); },
      });
    });

    all('[data-wt]').forEach((el) => el.addEventListener('click', () => {
      updateRough(roughId, { workType: el.dataset.wt }).catch(() => toast('保存できませんでした'));
    }));

    q('#r-gen').addEventListener('click', generate);
    q('#r-add').addEventListener('click', addBlank);
    q('#r-save').addEventListener('click', save);

    // 人工の増減
    all('[data-h]').forEach((el) => el.addEventListener('click', () => {
      const it = items.find((x) => x.id === el.dataset.h);
      if (!it) return;
      const next = Math.max(0, (num(it.hours) || 0) + Number(el.dataset.d));
      updateItem(roughId, it.id, { hours: next }).catch(() => toast('保存できませんでした'));
    }));
    all('[data-np]').forEach((el) => el.addEventListener('click', () => askNum(el.dataset.np, 'persons', '人数', '人')));
    all('[data-nh]').forEach((el) => el.addEventListener('click', () => askNum(el.dataset.nh, 'hours', '時間', 'h')));
    all('[data-km]').forEach((el) => el.addEventListener('click', () => askNum(el.dataset.km, 'km', '片道の距離', 'km')));

    all('[data-del]').forEach((el) => el.addEventListener('click', async () => {
      const it = items.find((x) => x.id === el.dataset.del);
      if (!it) return;
      if (await confirmDialog(`「${it.name || 'この行'}」を消しますか?`, '消す')) {
        try { await deleteItem(roughId, it.id); } catch (e) { console.error(e); toast('消せませんでした'); }
      }
    }));

    all('[data-use]').forEach((el) => el.addEventListener('click', () => {
      decideItem(roughId, el.dataset.use, el.dataset.src, local.get('staff', '')).catch(() => toast('保存できませんでした'));
    }));
    all('[data-pend]').forEach((el) => el.addEventListener('click', () => {
      markPending(roughId, el.dataset.pend).catch(() => toast('保存できませんでした'));
    }));
    all('[data-edit]').forEach((el) => el.addEventListener('click', () => editAmount(el.dataset.edit)));
    all('[data-ans]').forEach((el) => el.addEventListener('click', () => {
      answerQuestion(roughId, el.dataset.ans, el.dataset.ansv, local.get('staff', ''))
        .catch(() => toast('保存できませんでした'));
    }));
  }

  function askNum(id, field, title, unit) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    openNumpad({
      title, value: it[field] ?? '', unit, allowDecimal: field !== 'persons',
      onDone: (n) => { if (n != null) updateItem(roughId, id, { [field]: n }).catch(() => toast('保存できませんでした')); },
    });
  }

  function editAmount(id) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    const cur = itemAmount(it, ...Object.values(effectiveRates(rough))) ?? it.manualAmount ?? it.marketAmount ?? '';
    openNumpad({
      title: it.name || '金額', value: typeof cur === 'number' ? Math.round(cur) : '', unit: '円', allowDecimal: false,
      onDone: async (n) => {
        if (n == null) return;
        try {
          if (it.kind === '外注') await updateItem(roughId, id, { amount: n, state: '確定', chosen: 'yotsuba' });
          else await overrideItemAmount(roughId, id, n, local.get('staff', ''));
        } catch (e) { console.error(e); toast('保存できませんでした'); }
      },
    });
  }

  // 写真を大きく見る。AIが一致を出しても元の写真は必ず残す（CLAUDE.md）ので、
  // ここはいつでも開けるようにしておく。
  function viewPhoto(p) {
    const root = document.getElementById('modal-root');
    const v = document.createElement('div');
    v.className = 'photo-view';
    v.innerHTML = `
      <img src="${esc(p.url)}" alt="">
      <div class="pv-bar">
        <button class="btn btn-danger" id="pv-del">この写真を消す</button>
        <button class="btn" id="pv-x" style="color:#fff;border-color:#fff;background:transparent">閉じる</button>
      </div>`;
    root.appendChild(v);
    v.querySelector('#pv-x').addEventListener('click', () => v.remove());
    v.querySelector('#pv-del').addEventListener('click', async () => {
      if (!(await confirmDialog('この写真を消しますか?', '消す'))) return;
      try { await removePhoto(roughId, p.path); v.remove(); }
      catch (e) { console.error(e); toast('消せませんでした'); }
    });
  }

  async function pickPhoto(role) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = role === '図面' ? 'image/*,application/pdf' : 'image/*';
    if (role === '現場') input.capture = 'environment';
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return;
      toast('写真を送っています…');
      try { await uploadPhoto(roughId, f, role); toast('写真を足しました'); }
      catch (e) { console.error(e); toast('送れませんでした。電波を確認してください'); }
    });
    input.click();
  }

  async function generate() {
    if (busy) return;
    if (items.length && !(await confirmDialog(
      `いまの ${items.length}件 を消して、ひな形から出しなおします。よろしいですか?`, '出しなおす'))) return;
    busy = true; paint();
    try {
      if (items.length) await Promise.all(items.map((it) => deleteItem(roughId, it.id)));
      const res = await generateItems({
        workType: rough.workType, oneLiner: rough.oneLiner, photos: rough.photos || [],
      });
      await addItems(roughId, res.items);
      for (const qq of (res.questions || [])) await addQuestion(roughId, qq);
      toast(`${res.items.length}項目を出しました。人数と時間を直してください`);
    } catch (e) {
      console.error(e);
      toast(e.message || '項目を出せませんでした');
    } finally { busy = false; paint(); }
  }

  async function addBlank() {
    const kinds = ITEM_KINDS;
    const ov = openOverlay({ narrow: true });
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar"><button class="icon-btn" id="a-x">←</button><span class="ttl">項目を足す</span></div></div>
      <div class="page-body"><div class="form-page">
        <div style="font-size:13px;color:var(--muted);padding-bottom:10px">どの費目ですか</div>
        ${kinds.map((k) => `<button class="btn btn-block" style="height:56px;margin-bottom:8px" data-k="${k}">${k}</button>`).join('')}
      </div></div>`;
    ov.el.querySelector('#a-x').addEventListener('click', ov.close);
    ov.el.querySelectorAll('[data-k]').forEach((el) => el.addEventListener('click', () => {
      const kind = el.dataset.k;
      ov.close();
      openTextInput({
        title: '項目の名前', placeholder: '例）錆落とし', onDone: async (name) => {
          if (!name) return;
          const base = { kind, name, source: 'human', order: Date.now() };
          const seed = kind === '労務' ? { ...base, trade: '現場工事', persons: 2, hours: 8, state: '確定', chosen: 'yotsuba' }
            : kind === '移動' ? { ...base, persons: 2, hours: 1, km: null, state: '確定', chosen: 'yotsuba' }
              : { ...base, state: '単価待ち' };
          try { await addItem(roughId, seed); toast('足しました'); }
          catch (e) { console.error(e); toast('足せませんでした'); }
        },
      });
    }));
  }

  async function save() {
    if (busy) return;
    busy = true;
    try {
      const f = await freezeRough(roughId, rough, items, local.get('staff', ''));
      toast(`この金額で残しました（${YEN(f.band.displayLow)} 〜 ${YEN(f.band.displayHigh)}）`);
    } catch (e) { console.error(e); toast('残せませんでした'); }
    finally { busy = false; }
  }

  return () => stops.forEach((s) => s && s());
}

// ============================================================
// 表紙の情報
// ============================================================
export function openRoughCover(roughId, getRough) {
  const ov = openOverlay();
  const FIELDS = [
    ['projectName', '工事名', '例）駆動装置モーター更新及び駆動部オーバーホール工事'],
    ['customer', '宛先', '例）東レ株式会社愛媛工場'],
    ['site', '施工場所', '例）松山市 湯の山'],
  ];

  function paint() {
    const r = getRough() || {};
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar"><button class="icon-btn" id="c-x">←</button><span class="ttl">表紙の情報</span></div></div>
      <div class="page-body"><div class="form-page">
        ${FIELDS.map(([k, label]) => `
          <div class="field">
            <label>${label}</label>
            <button class="btn btn-block" style="justify-content:space-between;min-height:52px;font-size:16px;
              color:${r[k] ? 'var(--text)' : 'var(--muted2)'}" data-f="${k}">
              <span style="min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(r[k] || '（未入力）')}</span>
              <span style="color:var(--muted2)">✎</span></button>
          </div>`).join('')}
        <div class="field">
          <label>工事の種類</label>
          <div class="chips" style="flex-wrap:wrap;gap:8px">
            ${WORK_TYPES.map((w) => `<div class="chip ${r.workType === w ? 'on' : ''}" data-wt="${esc(w)}"
              style="min-height:44px;display:flex;align-items:center">${esc(TEMPLATE_LABELS[w] || w)}</div>`).join('')}
          </div>
        </div>
        <div class="field">
          <label>見積条件（消せません）</label>
          <div style="background:#fff;border:1px solid var(--line);border-radius:6px;padding:12px 14px;
            font-size:13px;line-height:1.8;color:#4A5A6B">${esc(DISCLAIMER)}</div>
          <div style="font-size:11.5px;color:var(--muted2);padding-top:6px">概算には必ずこの一文が入ります。</div>
        </div>
      </div></div>`;

    ov.el.querySelector('#c-x').addEventListener('click', ov.close);
    ov.el.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('click', () => {
      const k = el.dataset.f;
      const def = FIELDS.find((f) => f[0] === k);
      openTextInput({
        title: def[1], value: getRough()?.[k] || '', placeholder: def[2],
        onDone: async (v) => {
          if (v == null) return;
          try { await updateRough(roughId, { [k]: v }); paint(); }
          catch (e) { console.error(e); toast('保存できませんでした'); }
        },
      });
    }));
    ov.el.querySelectorAll('[data-wt]').forEach((el) => el.addEventListener('click', async () => {
      try { await updateRough(roughId, { workType: el.dataset.wt }); paint(); }
      catch (e) { console.error(e); toast('保存できませんでした'); }
    }));
  }

  paint();
}
