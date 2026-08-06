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
  WORK_TYPES, ITEM_KINDS, itemAmount, itemCandidates,
  yotsubaAmount, marketAmount, roughTotals, priceBand, counts, DISCLAIMER,
} from './rough-calc.js?v=33';
import {
  subscribeRough, subscribeRoughItems, subscribeRoughQuestions,
  effectiveRates, optionsFor, updateRough, addItems, updateItem, deleteItem,
  addItem, decideItem, overrideItemAmount, markPending, clearDecision,
  uploadPhoto, removePhoto, saveRoughSummary, freezeRough, addQuestion, answerQuestion,
} from './rough-store.js?v=33';
import { generateItems, isAiAvailable } from './rough-generate.js?v=33';
import { buildQuoteText, subjectOf, addressOf, pendingNames } from './rough-quote.js?v=33';
import { TEMPLATE_LABELS, templateRowCount } from './rough-templates.js?v=33';
import { openItemDetailPage } from './screen-item.js?v=33';

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
  let detail = null;        // 開いている「項目のくわしい中身」
  let topCollapsed = false; // 上（ヘッダー本体・写真・すること）を畳んでいるか
  let scrollY = 0;          // 描き直しても見ていた場所に留まるように持ち回る
  let lastBig = null;       // 直前が「まだ項目が無い」画面だったか

  const stops = [
    subscribeRough(roughId, (r) => {
      if (!r) { toast('概算が見つかりません'); location.hash = '#estimates'; return; }
      rough = r; paint();
    }),
    subscribeRoughItems(roughId, (list) => {
      items = list; paint(); pushSummary();
      if (detail) detail.refresh();     // 開いている「くわしく」も描き直す
    }),
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

  // ============================================================
  // 描画 — 画面/AI概算見積_UI設計/写真から見積.dc.html に合わせる
  //   44px ステータスバー相当は実機のセーフエリアが担う
  //   56px ヘッダー（濃紺グラデ・戻る・工事名）
  //   本文（写真 → 図面 → すること → 項目）
  //   下部の濃紺の帯（提出価格の目安・幅のバー・ボタン2つ）
  //   56px タブバーは app.js が付ける
  // モックの寸法・色・字の大きさをそのまま写している。勝手に変えない。
  // ============================================================

  const NAVY_GRAD = 'linear-gradient(180deg,#24507A 0%,#1B3A5C 100%)';

  // ---------- ヘッダー ----------
  // 寸法・色は app.css の .r-head が持つ（畳んだときの縮み方も同じ所に置く）
  function headerHtml() {
    return `
      <div class="r-head">
        <button id="r-back" class="r-back">‹</button>
        <button id="r-cover" class="r-title">
          <div class="t1">写真から見積</div>
          <div class="t2">${esc(rough.projectName || '工事名を入れる')}</div>
        </button>
      </div>`;
  }

  // ---------- 写真（項目を出す前・モックの①） ----------
  function photosHtml() {
    const list = rough.photos || [];
    const site = list.filter((p) => p.role !== '図面');
    const plans = list.filter((p) => p.role === '図面');
    const s = 78;

    const thumb = (p) => `
      <div data-ph="${esc(p.path)}" style="width:${s}px;height:${s}px;border-radius:6px;background:#5B6B7C;
        flex:none;position:relative;overflow:hidden;cursor:pointer">
        <img src="${esc(p.url)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">
      </div>`;

    const planThumb = (p) => `
      <div data-ph="${esc(p.path)}" style="width:${s}px;height:${s}px;border-radius:6px;background:#DDE3EA;
        border:1px solid #C3CBD4;display:flex;align-items:flex-end;justify-content:center;flex:none;
        overflow:hidden;position:relative;cursor:pointer">
        <img src="${esc(p.url)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">
        <span style="position:relative;background:#1B3A5C;color:#fff;font-size:10px;padding:2px 5px;margin-bottom:4px">図面</span>
      </div>`;

    return `
      <div style="display:flex;gap:8px;padding:12px 0 4px">
        ${site.map(thumb).join('')}
        <button id="ph-site" style="width:${s}px;height:${s}px;border-radius:6px;border:1.5px dashed #A9B3BE;
          background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
          color:#1B3A5C;flex:none;cursor:pointer;font-family:var(--font)">
          <span style="font-size:26px;display:grid;place-items:center">${icons.camera}</span>
          <span style="font-size:11px;font-weight:700">ふやす</span>
        </button>
      </div>
      <div style="font-size:11.5px;color:#8A96A3;padding:6px 2px 0">現場の写真 ${site.length}枚</div>

      <div style="font-size:13px;font-weight:700;color:#1B3A5C;padding:12px 0 6px">図面・スケッチ（あれば）</div>
      <div style="display:flex;align-items:center;gap:8px">
        ${plans.map(planThumb).join('')}
        <button id="ph-plan" style="width:${s}px;height:${s}px;border-radius:6px;border:1.5px dashed #A9B3BE;
          background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
          color:#1B3A5C;flex:none;cursor:pointer;font-family:var(--font)">
          <span style="font-size:24px;display:grid;place-items:center">${icons.camera}</span>
          <span style="font-size:11px;font-weight:700">紙を撮る</span>
        </button>
        <div style="flex:1;font-size:11.5px;color:#8A96A3;line-height:1.5">
          ${plans.length ? `図面 ${plans.length}枚を残しています` : '図面があれば<br>あとで寸法も読み取ります'}</div>
      </div>`;
  }

  // ---------- すること（項目を出す前・モックの①） ----------
  function oneLinerHtml() {
    return `
      <div style="padding:14px 0 0">
        <div style="font-size:13px;font-weight:700;color:#1B3A5C;padding-bottom:6px">すること</div>
        <button id="r-oneliner" style="width:100%;min-height:52px;background:#fff;border:1px solid #D9DEE4;
          border-radius:6px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 14px;
          font-size:16px;font-family:var(--font);text-align:left;cursor:pointer;
          color:${rough.oneLiner ? '#16202B' : '#A9B3BE'}">
          <span style="flex:1;min-width:0;line-height:1.4">${esc(rough.oneLiner || 'ポンプの駆動部を全部やりかえ')}</span>
          <span style="color:#8A96A3;font-size:18px;flex:none;display:grid;place-items:center">${icons.pencil}</span>
        </button>
      </div>`;
  }

  // ---------- 写真・図面・すること の帯（項目が並んだあと） ----------
  // 【なぜ小さくしたか】ここが約190pxあったので、項目が2つ半しか見えなかった。
  // 写真と一言は「項目を出す前」に入れるもので、出したあとは見えていれば足りる。
  // 押すところは前と同じ（写真を見る／写真をふやす／図面／すること）。増やしていない。
  // 下へスクロールすると .r-strip ごと畳まれる（app.css）。
  function stripHtml() {
    const list = rough.photos || [];
    const site = list.filter((p) => p.role !== '図面');
    const plans = list.filter((p) => p.role === '図面');
    const S = 'width:40px;height:40px;border-radius:5px;flex:none;overflow:hidden;position:relative;cursor:pointer';
    const ADD = 'width:40px;height:40px;border-radius:5px;border:1.5px dashed #A9B3BE;background:#fff;'
      + 'display:grid;place-items:center;color:#1B3A5C;flex:none;cursor:pointer;font-size:18px';

    return `
      <div class="r-thumbs">
        ${site.map((p) => `<div data-ph="${esc(p.path)}" style="${S};background:#5B6B7C">
          <img src="${esc(p.url)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block"></div>`).join('')}
        ${plans.map((p) => `<div data-ph="${esc(p.path)}" style="${S};background:#DDE3EA;border:1px solid #C3CBD4">
          <img src="${esc(p.url)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">
          <span style="position:absolute;left:0;right:0;bottom:0;background:rgba(27,58,92,.85);color:#fff;
            font-size:9px;text-align:center">図面</span></div>`).join('')}
        <button id="ph-site" style="${ADD}" aria-label="写真をふやす">${icons.camera}</button>
        <button id="ph-plan" style="${ADD}" aria-label="図面をふやす">${icons.filePlus}</button>
        <span style="flex:1;text-align:right;font-size:11px;color:#8A96A3;white-space:nowrap">
          写真${site.length}${plans.length ? `・図面${plans.length}` : ''}</span>
      </div>
      <button id="r-oneliner" style="width:100%;height:40px;margin-top:6px;background:#fff;border:1px solid #D9DEE4;
        border-radius:6px;display:flex;align-items:center;gap:8px;padding:0 10px 0 12px;
        font-size:14px;font-family:var(--font);text-align:left;cursor:pointer;
        color:${rough.oneLiner ? '#16202B' : '#A9B3BE'}">
        <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${esc(rough.oneLiner || 'すること を一言で')}</span>
        <span style="color:#8A96A3;font-size:16px;flex:none;display:grid;place-items:center">${icons.pencil}</span>
      </button>`;
  }

  // ---------- 項目を出す ----------
  // 【芯5】項目が並んだあとは「出しなおす」を出さない。
  // モックの一覧状態にも無い。押し間違えると全部消える危ないボタンでもある。
  // 出しなおしたいときは表紙から工事の種類を選び直す。
  function generateHtml() {
    const label = TEMPLATE_LABELS[rough.workType] || rough.workType;
    const n = templateRowCount(rough.workType);
    return `
      <div style="padding:16px 0 0">
        <button class="r-gen" style="width:100%;height:56px;background:${NAVY_GRAD};border:0;border-radius:6px;
          color:#fff;font-family:var(--font);font-size:18px;font-weight:700;display:flex;align-items:center;
          justify-content:center;gap:8px;cursor:pointer" ${busy ? 'disabled' : ''}>
          <span style="font-size:22px;display:grid;place-items:center">${icons.listSearch}</span>項目を出す</button>
        <div style="font-size:11.5px;color:#8A96A3;text-align:center;padding-top:8px;line-height:1.6">
          ${isAiAvailable()
            ? '押すと写真から項目を並べます。<br>金額はあとから一つずつ直せます。'
            : `押すと<b style="color:#1B3A5C">${esc(label)}</b>のひな形から${n}項目が並びます。<br>金額はあとから一つずつ直せます。`}
        </div>
      </div>`;
  }

  // ---------- ききたいこと ----------
  function questionHtml(q) {
    const opts = (q.options || []).length ? q.options : ['要る', '要らない'];
    return `
      <div style="background:#FBF2E4;border:1.5px solid #BA7517;border-radius:6px;padding:12px 14px">
        <div style="display:flex;align-items:center;gap:6px;color:#BA7517;font-size:12px;font-weight:700">
          <span style="font-size:15px;display:grid;place-items:center">${icons.question}</span>ききたいこと</div>
        ${q.about ? `<div style="font-size:16px;font-weight:700;color:#16202B;padding-top:6px">${esc(q.about)}</div>` : ''}
        <div style="font-size:${q.about ? 14 : 16}px;${q.about ? 'color:#4A5A6B' : 'font-weight:700;color:#16202B'};
          line-height:1.55;padding-top:${q.about ? 4 : 6}px">${esc(q.text)}</div>
        <div style="display:flex;gap:8px;padding-top:10px">
          ${opts.map((o, i) => `
            <button data-ans="${q.id}" data-ansv="${esc(o)}" style="flex:1;height:48px;border-radius:6px;
              font-family:var(--font);font-size:${opts.length > 2 ? 15 : 16}px;font-weight:700;cursor:pointer;
              ${i === 0 ? 'background:#BA7517;border:0;color:#fff' : 'background:#fff;border:1px solid #C6B79A;color:#7A5A18'}"
              >${esc(o)}</button>`).join('')}
        </div>
      </div>`;
  }

  // ---------- 項目カード ----------
  // 【詰めた理由】11〜12項目あるのに1画面に2つ半しか入らなかった。
  // 高さを削ったのは余白と行数だけで、名前16px・金額22pxの読みやすさは残している。
  //   ・名前と金額を同じ行に置く（前は金額が下段だった）
  //   ・材料/外注は「金額を直す」ボタンを金額そのものにした（押すところは減っている）
  // 1枚 約90px。ヘッダーが畳まれた状態で4〜5枚が一度に見える。
  const CARD = 'background:#fff;border:1px solid #D9DEE4;border-radius:6px;padding:10px 12px';
  const TITLE = 'font-size:16px;font-weight:700;color:#16202B;line-height:1.35';
  const AMT = 'font-family:var(--mono);font-size:22px;font-weight:700;color:#1B3A5C;letter-spacing:-.01em;'
    + 'line-height:1.1;white-space:nowrap';
  const STEP_BTN = 'width:46px;height:40px;background:#fff;border:1px solid #C3CBD4;border-radius:6px;color:#1B3A5C;'
    + 'font-family:var(--mono);font-size:14px;font-weight:700;cursor:pointer;flex:none';
  const SUB_BTN = 'height:40px;padding:0 10px;background:#fff;border:1px solid #C3CBD4;border-radius:6px;'
    + 'color:#1B3A5C;font-size:13px;font-weight:700;font-family:var(--font);cursor:pointer;flex:none';
  // 金額そのものを押させる（材料・外注の「金額を直す」）
  const AMT_BTN = 'display:flex;align-items:center;gap:6px;height:44px;padding:0 10px;background:#fff;'
    + 'border:1px solid #C3CBD4;border-radius:6px;cursor:pointer;flex:none;font-family:var(--font)';

  // 【芯5】押すところを増やさない。
  // モックの項目カードに削除ボタンは無いので、こちらでも出さない。
  // 要らない行は時間を0にすれば0円になる。行ごと消す道は、
  // 「項目のくわしい中身」を作るときにそちらへ入れる。
  function delBtn() { return ''; }

  function itemCard(it, rates, unitRates) {
    const amt = itemAmount(it, rates, unitRates);

    // 未確定 … よつばの単価と相場を2つ並べて、人に押させる
    if (it.state === '未確定') {
      const y = yotsubaAmount(it, rates, unitRates);
      const m = marketAmount(it);
      return `
        <div style="background:#fff;border:1px dashed #C3CBD4;border-radius:6px;padding:12px 14px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <div style="${TITLE}">${esc(it.name || '（名前なし）')}</div>
            <span style="font-size:11px;font-weight:700;color:#7A8794;border:1px solid #D2D8E0;border-radius:3px;
              padding:2px 6px;flex:none">未確定</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;padding-top:8px;font-size:13px;color:#6B7783">
            <span>よつばの単価</span>
            <span style="font-family:var(--mono)${y != null ? ';font-size:18px;font-weight:700;color:#16202B' : ''}">${y == null ? 'なし' : YEN(y)}</span></div>
          <div style="display:flex;align-items:center;justify-content:space-between;padding-top:4px;font-size:13px;color:#6B7783">
            <span style="display:flex;align-items:center;gap:6px">世の中の相場
              <span style="font-size:10.5px;font-weight:700;color:#1F6B5B;background:#E3F0EC;border-radius:3px;padding:2px 5px">相場</span></span>
            <span style="font-family:var(--mono);font-size:22px;font-weight:700;color:#1F6B5B;letter-spacing:-.01em">${m == null ? '—' : YEN(m)}</span></div>
          <div style="display:flex;gap:6px;padding-top:10px">
            <button data-use="${it.id}" data-src="${y != null ? 'yotsuba' : 'market'}" style="flex:1.2;height:48px;
              background:${NAVY_GRAD};border:0;border-radius:6px;color:#fff;font-family:var(--font);
              font-size:14px;font-weight:700;cursor:pointer">この金額を使う</button>
            <button data-edit="${it.id}" style="flex:1;height:48px;background:#fff;border:1px solid #C3CBD4;border-radius:6px;
              color:#1B3A5C;font-family:var(--font);font-size:14px;font-weight:700;cursor:pointer">金額を直す</button>
            <button data-pend="${it.id}" style="flex:1.1;height:48px;background:#fff;border:1px solid #C3CBD4;border-radius:6px;
              color:#1B3A5C;font-family:var(--font);font-size:14px;font-weight:700;cursor:pointer">単価待ち</button>
          </div>
          <div style="font-size:11.5px;color:#8A96A3;padding-top:8px">どれか押すまで合計に入りません</div>
        </div>`;
    }

    // 単価待ち … 左に山吹の帯。合計に入らない
    // 札は名前と同じ行に流し込む（前は説明が2行あり、1枚で110px使っていた）
    if (it.state === '単価待ち') {
      return `
        <div style="${CARD};border-left:4px solid #BA7517">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="flex:1;min-width:0">
              <div style="${TITLE}">
                <span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:700;color:#fff;
                  background:#BA7517;border-radius:3px;padding:2px 6px;vertical-align:2px;margin-right:5px">
                  <span style="font-size:12px;display:grid;place-items:center">${icons.clock}</span>単価待ち</span>${esc(it.name || '（名前なし）')}</div>
              <div style="font-size:11.5px;color:#8A96A3;padding-top:3px">聞いてから入れます。空けたまま先へ進めます</div>
            </div>
            <button data-edit="${it.id}" style="${SUB_BTN};height:44px">金額を入れる</button>
            ${delBtn(it.id)}
          </div>
        </div>`;
    }

    // 労務・移動 … 人数×時間をその場で増減
    if (it.kind === '労務' || it.kind === '移動') {
      const step = it.kind === '移動' ? 1 : 8;
      return `
        <div style="${CARD}">
          <div style="display:flex;align-items:baseline;gap:8px">
            <div style="${TITLE};flex:1;min-width:0">${esc(it.name || '（名前なし）')}</div>
            <span style="${AMT};flex:none">${YEN(amt || 0)}</span>${delBtn(it.id)}
          </div>
          <div style="display:flex;align-items:center;gap:6px;padding-top:6px">
            <div style="flex:1;min-width:0;font-size:12.5px;color:#4A5A6B;line-height:1.4">
              ${esc(it.kind === '移動' ? '移動労務' : (it.trade || ''))}
              <b data-np="${it.id}" style="font-family:var(--mono);font-weight:700;color:#16202B;cursor:pointer">${it.persons ?? 0}</b>人 ×
              <b data-nh="${it.id}" style="font-family:var(--mono);font-weight:700;color:#16202B;cursor:pointer">${it.hours ?? 0}</b>h</div>
            <button data-h="${it.id}" data-d="-${step}" style="${STEP_BTN}">−${step}h</button>
            <button data-h="${it.id}" data-d="${step}" style="${STEP_BTN}">＋${step}h</button>
            ${it.kind === '労務' ? `<button data-steps="${it.id}" style="${SUB_BTN};display:flex;align-items:center;gap:2px;
              background:#1B3A5C;border:0;color:#fff">くわしく<span style="font-size:11px;display:grid;place-items:center">${icons.caretRight}</span></button>` : ''}
          </div>
          ${it.kind === '移動' ? `
            <div style="font-size:12px;color:#6B7783;padding-top:6px">片道
              <b data-km="${it.id}" style="font-family:var(--mono);color:#16202B;cursor:pointer">${it.km ?? '—'}</b> km
              <span style="color:#A9B3BE">（往復で計算・${unitRates.kmRate}円/km）</span></div>` : ''}
        </div>`;
    }

    // 材料・外注（確定）
    // 金額そのものが「金額を直す」ボタン。押すところが1つ減り、1行に収まる
    const isMarket = it.chosen === 'market';
    return `
      <div style="${CARD}">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="${TITLE}">${esc(it.name || '（名前なし）')}</div>
            ${it.kind === '外注' ? '<div style="font-size:11.5px;color:#8A96A3;padding-top:3px">外注費 1式</div>' : ''}
            ${isMarket ? `<div style="padding-top:4px"><span style="display:inline-flex;align-items:center;gap:3px;
              font-size:11px;font-weight:700;color:#1F6B5B;background:#E3F0EC;border-radius:3px;padding:2px 6px">
              <span style="font-size:12px;display:grid;place-items:center">${icons.check}</span>相場で確定</span></div>` : ''}
          </div>
          <button data-edit="${it.id}" style="${AMT_BTN}" aria-label="金額を直す">
            <span style="${AMT}">${YEN(amt || 0)}</span>
            <span style="color:#8A96A3;font-size:15px;display:grid;place-items:center">${icons.pencil}</span>
          </button>
          ${delBtn(it.id)}
        </div>
      </div>`;
  }

  // ---------- 下の帯 ----------
  // 幅のバー: 中央値の±30%を目盛りにして、そこに幅を置く。
  // 決めるほど幅が狭まり、山吹の帯が短くなる。
  function bandBarHtml(band) {
    if (!band.hasAmount) return '<div style="height:6px;border-radius:3px;background:rgba(255,255,255,0.14);margin-top:6px"></div>';
    const mid = (band.displayLow + band.displayHigh) / 2 || 1;
    const lo = mid * 0.7, hi = mid * 1.3;
    const pct = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
    const left = pct(band.displayLow);
    const w = Math.max(4, pct(band.displayHigh) - left);
    return `
      <div style="height:6px;border-radius:3px;background:rgba(255,255,255,0.16);margin-top:6px;display:flex">
        <div style="width:${left}%"></div>
        <div style="width:${w}%;background:#BA7517;border-radius:3px"></div>
      </div>`;
  }

  // 帯を薄くした：
  //   ・見出しと「まだ決めていない〜」を同じ行に置く（1行ぶん＝約20px）
  //   ・下の env(safe-area-inset-bottom) をやめた。#app が
  //     「タブバー57px＋セーフエリア」ぶんの余白をすでに持っているので、
  //     ここで足すと iPhone では34pxを二重に空けていた（約34px）
  function bandHtml(band, c) {
    const note = !band.hasAmount
      ? '<span style="font-size:11.5px;color:rgba(255,255,255,0.68)">項目を出すと目安が出ます</span>'
      : c.undecided
        ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:#F0C888;white-space:nowrap">
             <span style="font-size:13px;display:grid;place-items:center">${icons.warning}</span>未確定 ${c.undecided}件</span>`
        : c.pending
          ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:#F0C888;white-space:nowrap">
               <span style="font-size:13px;display:grid;place-items:center">${icons.clock}</span>単価待ち ${c.pending}件</span>`
          : `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:#9FD5BE;white-space:nowrap">
               <span style="font-size:14px;display:grid;place-items:center">${icons.checkCircle}</span>${c.decided}件 確定</span>`;

    // 未確定が残っているあいだは「文面を作る」を押させない（モックと同じ）
    const canQuote = band.hasAmount && !c.undecided;
    return `
      <div style="flex:none;background:#1B3A5C;padding:8px 14px 10px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <span style="font-size:11.5px;color:rgba(255,255,255,0.68);white-space:nowrap">提出価格の目安（税込）</span>
          ${note}
        </div>
        <div style="font-family:var(--mono);font-size:26px;font-weight:700;letter-spacing:-.02em;padding-top:2px;
          line-height:1.15;white-space:nowrap;color:${band.hasAmount ? '#fff' : 'rgba(255,255,255,0.34)'}">
          ${band.hasAmount ? `${YEN(band.displayLow)} 〜 ${YEN(band.displayHigh)}` : '￥— 〜 ￥—'}</div>
        ${bandBarHtml(band)}
        <div style="display:flex;gap:8px;padding-top:8px">
          <button id="r-add" style="flex:1;height:48px;background:rgba(255,255,255,0.14);
            border:1px solid rgba(255,255,255,0.4);border-radius:6px;color:#fff;font-family:var(--font);
            font-size:16px;font-weight:700;cursor:pointer">項目を足す</button>
          <button id="r-quote" ${canQuote ? '' : 'disabled'} style="flex:1;height:48px;border-radius:6px;
            font-family:var(--font);font-size:16px;font-weight:700;display:flex;align-items:center;
            justify-content:center;gap:6px;
            ${canQuote
              ? 'background:#fff;border:0;color:#1B3A5C;cursor:pointer'
              : 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.45);cursor:not-allowed'}">
            <span style="font-size:19px;display:grid;place-items:center">${icons.fileText}</span>文面を作る</button>
        </div>
      </div>`;
  }

  // ---------- 全体 ----------
  // 項目が無いあいだ（モックの①）は写真・すること・「項目を出す」を本文に置く。
  // 項目が並んだら、写真とすることは上の帯（.r-strip）へ移して本文を項目だけにする。
  // 本文が項目だけになるので、スクロールの長さが項目の数そのものになる。
  function paint() {
    if (!rough) return;
    const { rates, unitRates, band, c } = calcAll();
    const open = questions.filter((q) => !q.answer);
    const big = items.length === 0;          // まだ項目が無いとき＝モックの①
    // ①→②に変わる瞬間は中身が丸ごと入れ替わる。前の位置は引き継がない
    if (lastBig !== big) { lastBig = big; scrollY = 0; topCollapsed = false; }

    const body = big ? `
      ${photosHtml()}
      ${oneLinerHtml()}
      ${generateHtml()}
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
        color:#8A96A3;border:1.5px dashed #C3CBD4;border-radius:6px;margin:16px 0 4px;padding:28px 20px">
        <span style="font-size:44px;color:#A9B3BE;display:grid;place-items:center">${icons.images}</span>
        <div style="font-size:14px;color:#6B7783;text-align:center;line-height:1.8">
          「項目を出す」を押すと、ここに項目が並びます。<br>金額はあとから一つずつ直せます。</div>
      </div>` : `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 2px 8px">
        <span style="font-size:13px;font-weight:700;color:#1B3A5C">読み取った項目</span>
        <span style="font-family:var(--mono);font-size:13px;font-weight:700;color:#7A8794">${c.items}件</span>
        <span style="flex:1;height:1px;background:#D2D8E0"></span>
        ${c.undecided
          ? `<span style="font-size:11.5px;color:#BA7517;font-weight:700">未確定 ${c.undecided}</span>`
          : `<span style="display:flex;align-items:center;gap:4px;font-size:11.5px;color:#1F6B5B;font-weight:700">
               <span style="font-size:14px;display:grid;place-items:center">${icons.checkCircle}</span>${c.decided}件 確定</span>`}
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${open.map(questionHtml).join('')}
        ${items.map((it) => itemCard(it, rates, unitRates)).join('')}
      </div>
      <div style="height:12px"></div>`;

    setHtmlKeepScroll(container, `
      <div class="screen" style="background:#EEF0F3">
        <div class="r-top${!big && topCollapsed ? ' collapsed' : ''}" id="r-top">
          ${headerHtml()}
          ${big ? '' : `<div class="r-strip">${stripHtml()}</div>`}
        </div>
        <div class="scroll est-list-scroll" id="r-scroll" style="padding:0 12px 12px">
          ${body}
        </div>
        ${bandHtml(band, c)}
      </div>`);

    bind();
  }

  // ---------- スクロールしたら上を引っ込める ----------
  // 押すところは増やさない（芯5）。指を下へ動かせば畳み、上へ戻せばまた出る。
  // 畳んでも scrollTop は動かないので、見ている項目はその場に留まる。
  function bindScroll() {
    const sc = container.querySelector('#r-scroll');
    const top = container.querySelector('#r-top');
    if (!sc || !top) return;
    if (scrollY) sc.scrollTop = scrollY;      // 描き直しのあとも同じ場所を見せる

    let lastY = sc.scrollTop;
    let upAcc = 0;                             // 上へ戻した量。少し戻せば上をまた出す
    const setCollapsed = (on) => {
      if (topCollapsed === on) return;
      topCollapsed = on;
      top.classList.toggle('collapsed', on);
    };

    sc.addEventListener('scroll', () => {
      const y = sc.scrollTop;
      const d = y - lastY;
      lastY = y;
      scrollY = y;
      if (items.length === 0) return;          // 項目が無いうちは畳まない
      if (d > 0) { upAcc = 0; if (y > 40) setCollapsed(true); }
      else if (d < 0) { upAcc -= d; if (y < 8 || upAcc > 56) setCollapsed(false); }
    }, { passive: true });
  }

  // ---------- 操作 ----------
  function bind() {
    const q = (s) => container.querySelector(s);
    const all = (s) => container.querySelectorAll(s);

    bindScroll();
    // 入ってきたタブへ戻す（ホームから入ればホーム）。app.js が覚えている
    q('#r-back').addEventListener('click', () => {
      location.hash = sessionStorage.getItem('lastTab') || '#estimates';
    });
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

    // 工事の種類は表紙で選ぶ（モックにこの画面のボタンが無いため）
    all('.r-gen').forEach((el) => el.addEventListener('click', generate));
    q('#r-add').addEventListener('click', addBlank);

    // 項目のくわしい中身（手順の内訳・行ごと消す）
    all('[data-steps]').forEach((el) => el.addEventListener('click', () => {
      detail = openItemDetailPage(roughId, el.dataset.steps, () => ({ rough, items, ...calcAll() }));
    }));
    // 文面を作る前に、そのときの率と金額を焼き付ける。
    // 客に出した金額と、あとで見る金額がずれないようにするため。
    q('#r-quote').addEventListener('click', async () => {
      await save({ quiet: true });
      openQuotePage(roughId, () => ({ rough, items, ...calcAll() }));
    });

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

  async function save({ quiet = false } = {}) {
    if (busy) return;
    busy = true;
    try {
      const f = await freezeRough(roughId, rough, items, local.get('staff', ''));
      if (!quiet) toast(`この金額で残しました（${YEN(f.band.displayLow)} 〜 ${YEN(f.band.displayHigh)}）`);
    } catch (e) { console.error(e); toast('残せませんでした'); }
    finally { busy = false; }
  }

  return () => stops.forEach((s) => s && s());
}

// ============================================================
// 文面を作る（画面4）
// 客先に出す文章。単価待ちは隠さず「追って連絡」と書く。
// getState() は { rough, items, rates, unitRates, t, band } を返す
// ============================================================
export function openQuotePage(roughId, getState) {
  const ov = openOverlay();
  const s = getState();
  const auto = buildQuoteText(s.rough, s.items, s.t, s.band, s.rates, s.unitRates);
  // 直したものがあればそれを出す。無ければ組み立てたものを出す
  let text = s.rough.quoteText || auto;
  const pend = pendingNames(s.items);

  function paint() {
    const edited = text !== auto;
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar">
        <button class="icon-btn" id="q-x">←</button><span class="ttl">文面を作る</span>
      </div></div>
      <div class="page-body"><div class="form-page">
        ${pend.length ? `
          <div style="display:flex;gap:8px;background:#FBF2E4;border:1px solid var(--accent);border-radius:6px;
            padding:10px 12px;margin-bottom:12px;font-size:12.5px;color:#5C3D0B;line-height:1.6">
            <span style="color:var(--accent);flex:none">${icons.clock}</span>
            <span>単価待ちが ${pend.length}件 あります。文面には<b>「追って連絡」</b>と入れています</span>
          </div>` : ''}

        <div class="field">
          <label>宛先</label>
          <div style="background:#fff;border:1px solid var(--line);border-radius:6px;padding:12px 14px;font-size:15px">
            ${esc(addressOf(s.rough) || '（宛先が入っていません。表紙の情報から入れてください）')}</div>
        </div>
        <div class="field">
          <label>件名</label>
          <div style="background:#fff;border:1px solid var(--line);border-radius:6px;padding:12px 14px;font-size:15px">
            ${esc(subjectOf(s.rough))}</div>
        </div>

        <div class="field">
          <label>本文${edited ? '（直したもの）' : ''}</label>
          <div id="q-body" style="background:#fff;border:1px solid var(--line);border-radius:6px;padding:14px;
            font-size:13.5px;line-height:1.9;white-space:pre-wrap;word-break:break-word">${esc(text)}</div>
        </div>

        <div style="background:var(--navy);border-radius:6px;padding:14px 16px;margin-bottom:14px">
          <div style="font-size:11.5px;color:rgba(255,255,255,.68)">御見積金額（税込）</div>
          <div class="num" style="font-size:24px;font-weight:700;color:#fff;padding-top:2px">
            ${YEN(s.band.displayLow)} 〜 ${YEN(s.band.displayHigh)}</div>
        </div>

        <button class="btn btn-block" style="height:52px;margin-bottom:8px" id="q-edit">文面を直す</button>
        ${edited ? `<button class="btn btn-block" style="height:44px;margin-bottom:8px" id="q-reset">作り直す（直した分は消えます）</button>` : ''}
      </div></div>
      <div class="bottom-bar" style="display:flex;gap:8px">
        <button class="btn" style="flex:1;height:52px" id="q-copy">コピーする</button>
        <button class="btn btn-primary" style="flex:1;height:52px" id="q-share">共有する</button>
      </div>`;

    ov.el.querySelector('#q-x').addEventListener('click', ov.close);
    ov.el.querySelector('#q-edit').addEventListener('click', () => {
      openTextInput({
        title: '文面を直す', value: text, multiline: true,
        hint: '直したものはこの見積に残ります。作り直せば元に戻せます。',
        onDone: async (v) => {
          if (v == null) return;
          text = v;
          try { await updateRough(roughId, { quoteText: v }); } catch (e) { console.error(e); toast('保存できませんでした'); }
          paint();
        },
      });
    });
    const reset = ov.el.querySelector('#q-reset');
    if (reset) reset.addEventListener('click', async () => {
      if (!(await confirmDialog('直した分を消して、作り直しますか?', '作り直す'))) return;
      text = auto;
      try { await updateRough(roughId, { quoteText: '' }); } catch (e) { console.error(e); }
      paint();
    });

    ov.el.querySelector('#q-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); toast('コピーしました。メールやLINEに貼り付けてください'); }
      catch (e) { console.warn(e); toast('コピーできませんでした。本文を長押しして選んでください'); }
    });
    ov.el.querySelector('#q-share').addEventListener('click', async () => {
      // iPhone は共有シート。使えない端末はコピーで代用する
      if (navigator.share) {
        try { await navigator.share({ title: subjectOf(s.rough), text }); return; }
        catch (e) { if (e.name === 'AbortError') return; console.warn(e); }
      }
      try { await navigator.clipboard.writeText(text); toast('この端末では共有が使えないのでコピーしました'); }
      catch (_) { toast('共有もコピーもできませんでした。本文を長押しして選んでください'); }
    });
  }

  paint();
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
