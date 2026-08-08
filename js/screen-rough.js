// ============================================================
// 写真から見積（画面1）
//
// 【2枚に分けてある】2026/8/7
//   写真・すること・項目を1枚に載せると、どれも狭くなって全部が中途半端だった。
//     写真のページ … 写真と図面の一覧／1枚を全画面／ピンチで拡大／足す・消す／左右で送る
//     概算のページ … すること と 項目一覧
//   行き来はヘッダー右の1つのボタンだけ（.r-swap）。増やしたのはこれだけ（芯5）。
//   ボタンは両方のページで同じ場所に置く。ページごとに動くと探すことになる。
//
// 【いまできること】
//   写真を撮って貼る（あとでAIが読む。今は残すだけ）
//   すること を一言だけ打つ
//   工事の種類を押す → ひな形から項目が並ぶ
//   工数（人数×工数）を直す → 金額と提出価格の幅が動く（直すのは「くわしく」の中）
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
// 金額と人数×時間を直す道は screen-item.js へ移した（一覧は見るところ）。
// openNumpad / overrideItemAmount / updateItem をここへ戻さないこと。
import { openOverlay, openTextInput, toast, confirmDialog, setHtmlKeepScroll } from './ui.js?v=33';
import {
  WORK_TYPES, ITEM_KINDS, itemAmount, kosuText, materialCountText,
  yotsubaAmount, marketAmount, roughTotals, priceBand, counts, DISCLAIMER,
} from './rough-calc.js?v=33';
import {
  subscribeRough, subscribeRoughItems, subscribeRoughQuestions,
  effectiveRates, optionsFor, updateRough, addItems, deleteItem,
  addItem, decideItem, markPending, saveGenerateResult,
  uploadPhoto, removePhoto, saveRoughSummary, freezeRough, addQuestion, answerQuestion, deferQuestion,
} from './rough-store.js?v=33';
import { generateItems, generateByTemplate, isAiAvailable } from './rough-generate.js?v=33';
import { buildQuoteText, subjectOf, addressOf, pendingNames } from './rough-quote.js?v=33';
import { TEMPLATE_LABELS, templateRowCount } from './rough-templates.js?v=33';
import { openItemDetailPage } from './screen-item.js?v=33';
import { openPhotoViewer as openPhotoViewerUI, isPdf } from './photo-viewer.js?v=33';

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
  let qOpen = false;        // ききたいことを開いているか。既定は畳む（芯2）
  let scrollY = 0;          // 描き直しても見ていた場所に留まるように持ち回る
  let lastBig = null;       // 直前が「まだ項目が無い」画面だったか
  let page = null;          // '写真' | '概算'。最初の1回だけ中身から決める（decidePage）
  let viewer = null;        // 開いている写真ビューア（写真が増減したら中身を入れ替える）
  // 写真を送っている最中の中身。null なら送っていない
  //   { done, total, failed, stage:'shrink'|'upload' }
  let sending = null;

  // まっさらな見積（写真も項目も無い）は写真のページから始める。
  // 「写真を撮る → 概算」の順に作るので、最初に開くのは写真の方が近い。
  // 一度でも自分でボタンを押したら、その選択を尊重して勝手に戻さない。
  //
  // 【items.length だけで見ない】最初の描き直しは見積の本体が届いた時点で走る。
  // 明細はまだ後から届くので、そのとき items は必ず空。
  // それだけで決めると、項目が入っている見積を開くたびに写真のページへ飛ぶ。
  // 見積の本体に写してある itemsCount（saveRoughSummary）で見る。
  function decidePage() {
    if (page) return;
    const noPhoto = !(rough.photos || []).length;
    const noItem = !(rough.itemsCount > 0) && items.length === 0;
    page = (noPhoto && noItem) ? '写真' : '概算';
  }

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
  //
  // 【この画面は動かさない】2026/8/7
  //   スクロールで畳む・出す・すべらせる を一切やらない。
  //   写真の帯も下の金額の帯も、いつでもそこにある。
  //   狭いときは動かして場所を作るのではなく、高さそのものを削る。
  //   現場は片手で見る。画面が動くと目で追えない。
  // ============================================================

  const NAVY_GRAD = 'linear-gradient(180deg,#24507A 0%,#1B3A5C 100%)';

  // ---------- ヘッダー ----------
  // 寸法・色は app.css の .r-head が持つ。1行48px。
  //   t1     … いま居るページ（写真／概算）
  //   t2     … 工事名。押すと表紙の情報
  //   r-swap … もう一方のページへ。行き先の名前と件数を出す
  // 「写真から見積」という名前はページが2枚になったので t1 では出さない。
  // どの見積かは工事名で分かるし、一覧やタブ側では概算見積のままにしてある。
  function headerHtml() {
    const nPhoto = (rough.photos || []).length;
    const to = page === '写真'
      ? { label: '概算', n: items.length, icon: icons.listSearch, aria: `概算のページへ（項目${items.length}件）` }
      : { label: '写真', n: nPhoto, icon: icons.images, aria: `写真のページへ（${nPhoto}枚）` };
    return `
      <div class="r-head">
        <button id="r-back" class="r-back">‹</button>
        <button id="r-cover" class="r-title">
          <span class="t1">${page === '写真' ? '写真' : '概算'}</span>
          <span class="t2">${esc(rough.projectName || '工事名を入れる')}</span>
        </button>
        <button id="r-swap" class="r-swap" aria-label="${esc(to.aria)}">
          ${to.icon}${to.label}<b>${to.n}</b>
        </button>
      </div>`;
  }

  // ---------- 写真のページ ----------
  // 写真と図面を一覧で見る。押すと1枚を全画面（openPhotoViewer）。
  // 消すのはビューアの中。一覧のタイルに×を付けると、見たいだけで押した人が
  // 消しかける。押すところも倍になる（芯5）。
  //
  // PDFで来た図面は <img> では出せない。潰れた画を出さずにPDFの札を出して、
  // ビューアから別のアプリで開けるようにする。無言で壊れて見えるのが一番悪い。
  // 判定は photo-viewer.js の isPdf と1つにしてある（見分け方が2つに割れないように）。
  function tileHtml(p) {
    if (isPdf(p)) {
      return `<button class="ph-tile pdf" data-ph="${esc(p.path)}" aria-label="図面のPDFを見る">PDF
        <span class="lb">図面</span></button>`;
    }
    return `
      <button class="ph-tile" data-ph="${esc(p.path)}" aria-label="この写真を大きく見る">
        <img src="${esc(p.url)}" alt="" loading="lazy">
        ${p.role === '図面' ? '<span class="lb">図面</span>' : ''}
      </button>`;
  }

  // ---------- 写真を送っている最中 ----------
  // 【何も起きていないように見えた】2026/8/7
  //   写真を選んだあと画面が何も変わらず、失敗したのか待てばいいのか分からなかった。
  //   1枚ならすぐ終わるが、5枚だと現場の電波では相当かかる。
  //   何枚目まで済んだかを出す。送り終わった写真はそのまま下の一覧に出る
  //   （Firestore の通知で1枚ずつ増える）ので、進んでいることが2重に分かる。
  //   縮めている最中も出す。端末の中の処理でも数秒かかることがあるため。
  function sendingHtml() {
    if (!sending) return '';
    const { done, total, failed, stage } = sending;
    const pct = Math.round((done / Math.max(1, total)) * 100);
    return `
      <div style="background:#fff;border:1px solid #D9DEE4;border-left:4px solid #1B3A5C;border-radius:6px;
        padding:12px 14px;margin-top:12px">
        <div style="display:flex;align-items:baseline;gap:8px">
          <span style="font-size:14px;font-weight:700;color:#1B3A5C">写真を送っています</span>
          <span style="flex:1"></span>
          <span style="font-family:var(--mono);font-size:16px;font-weight:700;color:#16202B">${done + 1 > total ? total : done + 1}枚目</span>
          <span style="font-size:12px;color:#8A96A3">／ ${total}枚</span>
        </div>
        <div class="send-bar"><div style="width:${pct}%"></div></div>
        <div style="font-size:12px;color:#6B7783;padding-top:6px;line-height:1.6">
          ${stage === 'shrink' ? '小さくしています…' : '送っています…'}
          送り終わった写真から下に出ます。${failed ? `<br><b style="color:#BA7517">${failed}枚は送れませんでした</b>` : ''}
        </div>
      </div>`;
  }

  function photoPageHtml() {
    const list = rough.photos || [];
    const site = list.filter((p) => p.role !== '図面');
    const plans = list.filter((p) => p.role === '図面');
    const head = (t, n, note) => `
      <div style="display:flex;align-items:center;gap:8px;padding:12px 2px 8px">
        <span style="font-size:13px;font-weight:700;color:#1B3A5C">${t}</span>
        <span style="font-family:var(--mono);font-size:13px;font-weight:700;color:#7A8794">${n}</span>
        <span style="flex:1;height:1px;background:#D2D8E0"></span>
        ${note ? `<span style="font-size:11.5px;color:#8A96A3">${note}</span>` : ''}
      </div>`;

    return `
      ${sendingHtml()}
      ${head('現場の写真', `${site.length}枚`, '押すと大きく見えます')}
      <div class="ph-grid">
        ${site.map(tileHtml).join('')}
        <button id="ph-site" class="ph-add" ${sending ? 'disabled' : ''} aria-label="現場の写真をふやす">
          ${icons.camera}ふやす</button>
      </div>

      ${head('図面・スケッチ', `${plans.length}枚`, '')}
      <div class="ph-grid">
        ${plans.map(tileHtml).join('')}
        <button id="ph-plan" class="ph-add" ${sending ? 'disabled' : ''} aria-label="図面をふやす">
          ${icons.filePlus}紙を撮る</button>
      </div>
      <div style="font-size:11.5px;color:#8A96A3;padding:10px 2px 0;line-height:1.7">
        指2本でひろげると大きくなります。継手の形や銘板の文字はここで確かめてください。<br>
        写真を消すのは、大きくしたあとの画面からです。
      </div>
      <div style="height:12px"></div>`;
  }

  // ---------- すること（概算のページ） ----------
  // 項目と一緒にスクロールさせる。書いたら用が済むもので、貼り付けておく値打ちは無い。
  // 貼り付けるものを減らすほど項目が見える。
  function oneLinerHtml() {
    return `
      <button id="r-oneliner" class="r-oneliner" style="color:${rough.oneLiner ? '#16202B' : '#A9B3BE'}">
        <span class="lb">すること</span>
        <span class="tx">${esc(rough.oneLiner || '一言で（例）ポンプの駆動部を全部やりかえ')}</span>
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
  // 【畳んである理由】
  //   現場は質問に答えに来たのではなく、見積を出しに来ている。
  //   3件が全部開いていると画面を占領し、「答えないと進めない」に見える。
  //   答えなくても項目と金額はもう出ている。だから既定は畳む（芯2）。
  //   ただし件数は必ず出す。隠すのではなく畳むだけ（芯4）。
  function questionStripHtml(asking, later) {
    const n = asking.length;
    const l = later.length;
    if (!n && !l) return '';
    const label = n
      ? `ききたいこと <span style="font-family:var(--mono)">${n}</span>件`
      : `ききたいこと（あとで）<span style="font-family:var(--mono)">${l}</span>件`;
    const color = n ? '#BA7517' : '#8A96A3';
    return `
      <button id="q-toggle" style="width:100%;display:flex;align-items:center;gap:8px;
        background:${n ? '#FBF2E4' : '#F2F4F7'};border:1px solid ${n ? '#E0CDA6' : '#D9DEE4'};border-radius:6px;
        padding:9px 12px;font-family:var(--font);font-size:13px;font-weight:700;color:${color};cursor:pointer">
        <span style="font-size:15px;display:grid;place-items:center">${icons.question}</span>
        <span style="flex:1;text-align:left">${label}</span>
        ${n && l ? `<span style="font-weight:400;color:#8A96A3">あとで ${l}</span>` : ''}
        <span style="font-size:15px;display:grid;place-items:center;transform:rotate(${qOpen ? 180 : 0}deg)">${icons.caretDown}</span>
      </button>`;
  }

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
        <div style="display:flex;justify-content:flex-end;padding-top:8px">
          <button data-later="${q.id}" style="background:transparent;border:0;font-family:var(--font);
            font-size:13px;font-weight:700;color:#8A7550;text-decoration:underline;cursor:pointer;padding:4px 2px"
            >あとで</button>
        </div>
      </div>`;
  }

  // ---------- 項目カード ----------
  // 【一覧は見るところ、くわしくは直すところ】2026/8/7
  //   前はカードの上で人数・時間・金額を直せた。一覧と直しが混ざっていて迷う。
  //   直すのは「項目のくわしい中身」（screen-item.js）だけにした。
  //   ・±8h／±1h、人数・時間・kmの数字、金額を直すボタン … すべて一覧から外した
  //     ざっくりの段階で1時間ずつ動かしても、出す金額はまだ幅で持っている
  //   ・カードぜんたいが「くわしく」への入口。押すところは1枚に1つ
  //   ・消すのもくわしくの中。間違って足したものはそこで消す
  //   例外は未確定の2つだけ（この金額を使う／単価待ちにする）。
  //   これは金額を直すのではなく、合計に入れるかどうかを決めるボタン。
  //   AIが出した金額は人が押すまで合計に入らない、という決めごとを持っている。
  //
  // 【詰めた理由】11〜12項目あるのに1画面に2つ半しか入らなかった。
  // 高さを削ったのは余白と行数だけで、名前16px・金額22pxの読みやすさは残している。
  // 押すところがカード1枚になったので、軍手でも狙いを外さない。
  const CARD = 'width:100%;text-align:left;font-family:var(--font);background:#fff;border:1px solid #D9DEE4;'
    + 'border-radius:6px;padding:8px 12px;cursor:pointer;display:block';
  const TITLE = 'font-size:16px;font-weight:700;color:#16202B;line-height:1.25';
  const AMT = 'font-family:var(--mono);font-size:22px;font-weight:700;color:#1B3A5C;letter-spacing:-.01em;'
    + 'line-height:1.1;white-space:nowrap';
  const SUB = 'font-size:12.5px;color:#4A5A6B;line-height:1.4';
  // カードのどこを押しても「くわしく」が開く、と分かるための印
  const MORE = `<span style="flex:none;display:flex;align-items:center;gap:1px;font-size:12px;font-weight:700;color:#1B3A5C">
    くわしく<span style="font-size:11px;display:grid;place-items:center">${icons.caretRight}</span></span>`;

  // 材料の数え方の1行。「定尺4m × 15本（60m分）」
  // 現場と発注は本数で数えるので、合計の長さだけでは足りない（2026/8/8 現場より）。
  // 定尺が引けなかったものは総量のまま出す。黙って本数にしない（芯4）。
  const matLine = (it) => {
    const t = materialCountText(it);
    if (!t) return '';
    const unresolved = !it.perLengthM && it.totalM != null;
    return `<div style="font-size:12px;color:${unresolved ? '#8A560F' : '#6B7783'};
      font-family:var(--mono);padding-top:3px">${esc(t)}</div>`;
  };

  function itemCard(it, rates, unitRates) {
    const amt = itemAmount(it, rates, unitRates);
    const open = `data-steps="${it.id}"`;   // 押すと「項目のくわしい中身」

    // 未確定 … よつばの単価と相場を2つ並べて、人に押させる
    // 金額を直すのはくわしくの中。ここに残すのは「合計に入れるかどうか」の2つだけ
    if (it.state === '未確定') {
      const y = yotsubaAmount(it, rates, unitRates);
      const m = marketAmount(it);
      return `
        <div style="background:#fff;border:1px dashed #C3CBD4;border-radius:6px;padding:10px 14px">
          <button ${open} style="width:100%;text-align:left;background:none;border:0;padding:0;
            font-family:var(--font);cursor:pointer">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
              <div style="${TITLE}">${esc(it.name || '（名前なし）')}</div>
              <span style="font-size:11px;font-weight:700;color:#7A8794;border:1px solid #D2D8E0;border-radius:3px;
                padding:2px 6px;flex:none">未確定</span>
            </div>
            ${matLine(it)}
            <div style="display:flex;align-items:center;justify-content:space-between;padding-top:6px;font-size:13px;color:#6B7783">
              <span>よつばの単価</span>
              <span style="font-family:var(--mono)${y != null ? ';font-size:18px;font-weight:700;color:#16202B' : ''}">${y == null ? 'なし' : YEN(y)}</span></div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding-top:3px;font-size:13px;color:#6B7783">
              <span style="display:flex;align-items:center;gap:6px">世の中の相場
                <span style="font-size:10.5px;font-weight:700;color:#1F6B5B;background:#E3F0EC;border-radius:3px;padding:2px 5px">相場</span></span>
              <span style="font-family:var(--mono);font-size:22px;font-weight:700;color:#1F6B5B;letter-spacing:-.01em">${m == null ? '—' : YEN(m)}</span></div>
          </button>
          <div style="display:flex;gap:6px;padding-top:8px">
            <button data-use="${it.id}" data-src="${y != null ? 'yotsuba' : 'market'}" style="flex:1.3;height:48px;
              background:${NAVY_GRAD};border:0;border-radius:6px;color:#fff;font-family:var(--font);
              font-size:15px;font-weight:700;cursor:pointer">この金額を使う</button>
            <button data-pend="${it.id}" style="flex:1;height:48px;background:#fff;border:1px solid #C3CBD4;border-radius:6px;
              color:#1B3A5C;font-family:var(--font);font-size:15px;font-weight:700;cursor:pointer">単価待ち</button>
          </div>
          <div style="display:flex;align-items:center;gap:8px;padding-top:6px">
            <span style="flex:1;font-size:11.5px;color:#8A96A3">どれか押すまで合計に入りません</span>
            <button ${open} style="background:none;border:0;padding:2px;cursor:pointer">${MORE}</button>
          </div>
        </div>`;
    }

    // 単価待ち … 左に山吹の帯。合計に入らない
    if (it.state === '単価待ち') {
      return `
        <button ${open} style="${CARD};border-left:4px solid #BA7517">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="flex:1;min-width:0">
              <div style="${TITLE}">
                <span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:700;color:#fff;
                  background:#BA7517;border-radius:3px;padding:2px 6px;vertical-align:2px;margin-right:5px">
                  <span style="font-size:12px;display:grid;place-items:center">${icons.clock}</span>単価待ち</span>${esc(it.name || '（名前なし）')}</div>
              ${matLine(it)}
              <div style="font-size:11.5px;color:#8A96A3;padding-top:3px">聞いてから入れます。空けたまま先へ進めます</div>
            </div>
            ${MORE}
          </div>
        </button>`;
    }

    // 労務・移動 … 人数×工数は見せるだけ。直すのはくわしくの中
    // 労務は工数（1工数＝8時間）。移動だけは時間のまま
    // （片道1時間を0.125工数と書いても読めない）。
    if (it.kind === '労務' || it.kind === '移動') {
      const travel = it.kind === '移動';
      const B = 'font-family:var(--mono);font-weight:700;color:#16202B';
      return `
        <button ${open} style="${CARD}">
          <div style="display:flex;align-items:baseline;gap:8px">
            <div style="${TITLE};flex:1;min-width:0">${esc(it.name || '（名前なし）')}</div>
            <span style="${AMT};flex:none">${YEN(amt || 0)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;padding-top:5px">
            <div style="flex:1;min-width:0;${SUB}">
              ${esc(travel ? '移動労務' : (it.trade || ''))}
              <b style="${B}">${it.persons ?? 0}</b>人 ×
              ${travel
                ? `<b style="${B}">${it.hours ?? 0}</b>h　片道 <b style="${B}">${it.km ?? '—'}</b> km`
                : `<b style="${B}">${kosuText(it.hours)}</b>工数`}</div>
            ${MORE}
          </div>
        </button>`;
    }

    // 材料・外注（確定）
    const isMarket = it.chosen === 'market';
    return `
      <button ${open} style="${CARD}">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="${TITLE}">${esc(it.name || '（名前なし）')}</div>
            ${matLine(it)}
            <div style="display:flex;align-items:center;gap:6px;padding-top:3px">
              ${it.kind === '外注' ? '<span style="font-size:11.5px;color:#8A96A3">外注費 1式</span>' : ''}
              ${isMarket ? `<span style="display:inline-flex;align-items:center;gap:3px;
                font-size:11px;font-weight:700;color:#1F6B5B;background:#E3F0EC;border-radius:3px;padding:2px 6px">
                <span style="font-size:12px;display:grid;place-items:center">${icons.check}</span>相場で確定</span>` : ''}
              ${MORE}
            </div>
          </div>
          <span style="${AMT};flex:none">${YEN(amt || 0)}</span>
        </div>
      </button>`;
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
  // この帯は常に出したままにする。引っ込めない。
  // 現場は親指の届く下側で金額を見る。スクロールで消えると金額を見失う。
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
      <div style="flex:none;background:#1B3A5C;padding:7px 14px 8px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <span style="font-size:11.5px;color:rgba(255,255,255,0.68);white-space:nowrap">提出価格の目安（税込）</span>
          ${note}
        </div>
        <div style="font-family:var(--mono);font-size:26px;font-weight:700;letter-spacing:-.02em;padding-top:2px;
          line-height:1.15;white-space:nowrap;color:${band.hasAmount ? '#fff' : 'rgba(255,255,255,0.34)'}">
          ${band.hasAmount ? `${YEN(band.displayLow)} 〜 ${YEN(band.displayHigh)}` : '￥— 〜 ￥—'}</div>
        ${bandBarHtml(band)}
        <div style="display:flex;gap:8px;padding-top:6px">
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
  // ページは2枚。貼り付いているのはヘッダー（48px）だけ。
  //   写真 … 一覧だけ。下の金額の帯は出さない（写真を大きく並べる方が要る）
  //   概算 … すること＋項目一覧。下に金額の帯（常に見える）
  // すること は概算の本文に入れて一緒にスクロールさせる。
  // 貼り付けるものが減ったぶん、項目が一度に見える数が増えている。
  function paint() {
    if (!rough) return;
    decidePage();
    const { rates, unitRates, band, c } = calcAll();
    const unanswered = questions.filter((q) => !q.answer);
    const asking = unanswered.filter((q) => !q.deferred);   // まだ聞きたい
    const later = unanswered.filter((q) => q.deferred);     // ［あとで］で脇へどけた
    const big = items.length === 0;          // まだ項目が無いとき
    // 中身が丸ごと入れ替わる境目では、前の位置を引き継がない
    if (lastBig !== big) { lastBig = big; scrollY = 0; }

    const estBody = big ? `
      ${oneLinerHtml()}
      ${generateHtml()}
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
        color:#8A96A3;border:1.5px dashed #C3CBD4;border-radius:6px;margin:16px 0 4px;padding:28px 20px">
        <span style="font-size:44px;color:#A9B3BE;display:grid;place-items:center">${icons.images}</span>
        <div style="font-size:14px;color:#6B7783;text-align:center;line-height:1.8">
          「項目を出す」を押すと、ここに項目が並びます。<br>金額はあとから一つずつ直せます。</div>
      </div>` : `
      ${oneLinerHtml()}
      ${originHtml()}
      <div style="display:flex;align-items:center;gap:8px;padding:7px 2px 6px">
        <span style="font-size:13px;font-weight:700;color:#1B3A5C">読み取った項目</span>
        <span style="font-family:var(--mono);font-size:13px;font-weight:700;color:#7A8794">${c.items}件</span>
        <span style="flex:1;height:1px;background:#D2D8E0"></span>
        ${c.undecided
          ? `<span style="font-size:11.5px;color:#BA7517;font-weight:700">未確定 ${c.undecided}</span>`
          : `<span style="display:flex;align-items:center;gap:4px;font-size:11.5px;color:#1F6B5B;font-weight:700">
               <span style="font-size:14px;display:grid;place-items:center">${icons.checkCircle}</span>${c.decided}件 確定</span>`}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${questionStripHtml(asking, later)}
        ${qOpen ? [...asking, ...later].map(questionHtml).join('') : ''}
        ${items.map((it) => itemCard(it, rates, unitRates)).join('')}
      </div>
      <div style="height:10px"></div>`;

    const photo = page === '写真';
    setHtmlKeepScroll(container, `
      <div class="screen" style="background:#EEF0F3">
        <div class="r-top" id="r-top">${headerHtml()}</div>
        <div class="scroll ${photo ? 'ph-scroll' : 'est-list-scroll'}" id="r-scroll" style="padding:0 12px 12px">
          ${photo ? photoPageHtml() : estBody}
        </div>
        ${photo ? '' : bandHtml(band, c)}
      </div>`);

    bind();
    if (viewer) viewer.refresh(rough.photos || []);   // 開いているビューアにも増減を伝える
  }

  // ---------- 見ていた場所を覚えるだけ ----------
  // 【畳む仕組みを外した】2026/8/7
  //   前はここでスクロールの向きを見て .r-top に collapsed を付け外ししていた。
  //   実機だと畳むたびに再レイアウトが走って動きが引っかかり、
  //   片手で見ている現場では目で追えなかった。
  //   場所は動きで作らず、最初から薄く作る（app.css の .r-head）。
  //   足りなければページを分ける（写真は別ページへ出した）。
  //   ここに畳む処理を戻さないこと。
  //
  //   残しているのは scrollTop の記録だけ。＋8h を押すと Firestore の
  //   通知で描き直しが起きるので、覚えていないと一覧の先頭へ飛ぶ。
  //   これは「動き」ではなく「動かさないため」の処理。
  function bindScroll() {
    const sc = container.querySelector('#r-scroll');
    if (!sc) return;
    if (scrollY) sc.scrollTop = scrollY;      // 描き直しのあとも同じ場所を見せる
    sc.addEventListener('scroll', () => { scrollY = sc.scrollTop; }, { passive: true });
  }

  // ---------- 操作 ----------
  // ページが2枚になったので、片方にしか無いボタンがある。
  // 無ければ黙って何もしない on() を通す（q(...).addEventListener だと落ちる）。
  function bind() {
    const q = (s) => container.querySelector(s);
    const all = (s) => container.querySelectorAll(s);
    const on = (s, fn) => { const el = q(s); if (el) el.addEventListener('click', fn); };

    bindScroll();
    // 入ってきたタブへ戻す（ホームから入ればホーム）。app.js が覚えている
    on('#r-back', () => {
      location.hash = sessionStorage.getItem('lastTab') || '#estimates';
    });
    on('#r-cover', () => openRoughCover(roughId, () => rough));

    // 写真 ⇄ 概算。増やしたのはこの1つだけ（芯5）
    on('#r-swap', () => {
      page = page === '写真' ? '概算' : '写真';
      scrollY = 0;            // 別のページなので、前のページの位置は引き継がない
      paint();
    });

    on('#ph-site', () => pickPhoto('現場'));
    on('#ph-plan', () => pickPhoto('図面'));
    // 写真は押したら「大きく見る」。消すのは その中のボタンから。
    // 見たいだけで押した人に、いきなり削除を聞かない。
    all('[data-ph]').forEach((el) => el.addEventListener('click', () => {
      openPhotoViewer(el.dataset.ph);
    }));

    on('#r-oneliner', () => {
      openTextInput({
        title: 'すること', value: rough.oneLiner || '', multiline: true,
        placeholder: '例）ポンプの駆動部を全部やりかえ',
        hint: '一言で構いません。AIが入ったら、この言葉と写真から項目を出します。',
        onDone: (v) => { if (v != null) updateRough(roughId, { oneLiner: v }).catch(() => toast('保存できませんでした')); },
      });
    });

    // 工事の種類は表紙で選ぶ（モックにこの画面のボタンが無いため）
    all('.r-gen').forEach((el) => el.addEventListener('click', generate));
    on('#r-add', addBlank);

    // 項目のくわしい中身。直すのも消すのも、入口はここだけ（芯5）。
    // カードぜんたいが入口なので、1枚につき押すところは1つ。
    all('[data-steps]').forEach((el) => el.addEventListener('click', () => {
      detail = openItemDetailPage(roughId, el.dataset.steps, () => ({ rough, items, ...calcAll() }));
    }));
    // 文面を作る前に、そのときの率と金額を焼き付ける。
    // 客に出した金額と、あとで見る金額がずれないようにするため。
    on('#r-quote', async () => {
      await save({ quiet: true });
      openQuotePage(roughId, () => ({ rough, items, ...calcAll() }));
    });

    // 【一覧から直す道を外した】2026/8/7
    //   ここにあった ±8h／±1h・人数・時間・km・金額を直す は全部
    //   「項目のくわしい中身」（screen-item.js）へ移した。
    //   一覧は見るところ。直すところと混ざっていると迷う。ここに戻さないこと。
    //
    // 残しているのは未確定の2つだけ。これは金額を直すのではなく、
    // 合計に入れるかどうかを決めるボタン（AIの金額は人が押すまで入らない）。
    all('[data-use]').forEach((el) => el.addEventListener('click', () => {
      decideItem(roughId, el.dataset.use, el.dataset.src, local.get('staff', '')).catch(() => toast('保存できませんでした'));
    }));
    all('[data-pend]').forEach((el) => el.addEventListener('click', () => {
      markPending(roughId, el.dataset.pend).catch(() => toast('保存できませんでした'));
    }));
    all('[data-ans]').forEach((el) => el.addEventListener('click', () => {
      answerQuestion(roughId, el.dataset.ans, el.dataset.ansv, local.get('staff', ''))
        .catch(() => toast('保存できませんでした'));
    }));
    const qt = q('#q-toggle');
    if (qt) qt.addEventListener('click', () => { qOpen = !qOpen; paint(); });
    all('[data-later]').forEach((el) => el.addEventListener('click', () => {
      // 消さずに脇へどけるだけ。件数は「あとで」として残り続ける（芯4）
      deferQuestion(roughId, el.dataset.later).catch(() => toast('保存できませんでした'));
    }));
  }

  // 写真を大きく見る（ピンチで拡大・左右で送る）。中身は js/photo-viewer.js。
  // ここは「どの写真を渡すか」「消すと決まったら Firestore をどう触るか」だけ持つ。
  // ビューア側は Firebase を知らないので、tools/test-photo-viewer.html から
  // 実物のまま指の動きを試せる（写しを作らない）。
  function openPhotoViewer(startPath) {
    if (viewer) return;
    viewer = openPhotoViewerUI({
      photos: rough.photos || [],
      startPath,
      onDelete: async (p) => {
        try { await removePhoto(roughId, p.path); }
        catch (e) { console.error(e); toast('消せませんでした'); }
      },
      onClose: () => { viewer = null; },
    });
  }

  // 【1枚しか入らなかった理由】
  //   capture='environment' を付けるとiPadはカメラに直行し、アルバムを選べない。
  //   さらに files[0] しか見ていなかったので、何枚選んでも1枚しか入らなかった。
  //   capture を外すと「写真を撮る／アルバムから選ぶ」が最初から両方出る。
  //   multiple を付けると、アルバムから一度に何枚でも入る（現場の5枚10枚はこちら）。
  //   ※カメラを開いたまま連続で撮ることは、iOS側の作りでできない。
  //     続けて撮るときは撮るたびにこのボタンを押す。まとめるならアルバムから選ぶ。
  async function pickPhoto(role) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = role === '図面' ? 'image/*,application/pdf' : 'image/*';
    input.multiple = true;
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      // 何枚目まで済んだかを画面に出す。トーストは消えるので進み具合には使わない
      sending = { done: 0, total: files.length, failed: 0, stage: 'shrink' };
      if (page !== '写真') page = '写真';    // 送っているところが見えるページへ
      paint();
      let ok = 0;
      // 1枚ずつ送る。1枚失敗しても残りは入れる（芯2）
      for (const f of files) {
        try {
          await uploadPhoto(roughId, f, role, (stage) => {
            if (sending) { sending.stage = stage; paint(); }
          });
          ok += 1;
        } catch (e) { console.error(e); if (sending) sending.failed += 1; }
        if (sending) { sending.done += 1; paint(); }
      }
      const ng = sending ? sending.failed : 0;
      sending = null;
      paint();
      if (ng) toast(`${ok}枚入れました。${ng}枚は送れませんでした。電波を確認してください`);
      else toast(ok > 1 ? `写真を${ok}枚足しました` : '写真を足しました');
    });
    input.click();
  }

  // ---------- 項目を出している最中 ----------
  // 【何も起きていないように見えた】2026/8/7
  //   押してから項目が出るまで画面が変わらなかった。AIは写真を読んで考えるので、
  //   30秒〜2分かかる。何も動かないと、待てばいいのか失敗したのか分からない。
  //
  // 【経過秒はほんとうの数字。段取りは作り話にしない】
  //   受付の呼び出しは1回きりで、いま何合目かは外からは分からない。
  //   だから「いま写真を読んでいます」のような、確かめようのない実況は出さない。
  //   出すのは ①ほんとうに測っている経過秒 ②AIに頼んだ中身（毎回同じ4つ）。
  //   動いていることは、経過秒とバーが受け持つ。
  let veil = null;
  let veilTimer = null;

  function openWorkVeil(nPhotos) {
    closeWorkVeil();
    const started = Date.now();
    const el = document.createElement('div');
    el.className = 'work-veil';
    el.innerHTML = `
      <div class="wv-card">
        <div class="wv-title">AIが読んでいます</div>
        <div class="wv-time"><span id="wv-sec">0:00</span></div>
        <div class="wv-bar"><div></div></div>
        <div class="wv-note">
          ${nPhotos ? `写真 <b>${nPhotos}枚</b>と、すること を渡しました。` : '写真は渡していません。工事の種類とすること だけで出します。'}
        </div>
        <div class="wv-list">
          <div>頼んでいること</div>
          <ul>
            <li>やることを順番に並べる</li>
            <li>何人で何時間かかるかを出す</li>
            <li>世の中の相場を出す</li>
            <li>写真から分からないことを質問にする</li>
          </ul>
        </div>
        <div class="wv-hint">だいたい30秒〜2分かかります。このまま待ってください。<br>
          つながらないときは、ひな形から出しなおします。</div>
      </div>`;
    document.getElementById('modal-root').appendChild(el);
    veil = el;
    const tick = () => {
      const s = Math.floor((Date.now() - started) / 1000);
      const t = el.querySelector('#wv-sec');
      if (t) t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    veilTimer = setInterval(tick, 1000);
  }
  function closeWorkVeil() {
    if (veilTimer) { clearInterval(veilTimer); veilTimer = null; }
    if (veil) { veil.remove(); veil = null; }
  }

  // ---------- 項目の出どころ（AI か ひな形か） ----------
  // 【トーストに頼らない】AIにつながらないとひな形に戻る。前はトーストでしか
  // 知らせておらず、見逃すと「AIが相場を出さない」のか「そもそもAIが動いていない」のか
  // 分からなくなっていた。実際にそれで1回混乱した（2026/8/7）。
  // 見積本体に残して、一覧の上にいつでも出す（芯4）。
  // 【片方だけを黙らせない】2026/8/8
  // よつばの単価と相場は2つで1組。片方しか無いと比べられないので現場では使えない。
  // 8/7 は相場が、8/8 はよつばの単価が黙って消えた。どちらも画面は普通に出ていたので
  // 見た人が気づけず、実データを掘るまで分からなかった。件数で出せば、その場で気づける。
  function coverageNote(g) {
    const c = g && g.coverage;
    if (!c) return '';
    const miss = [];
    if (c.missingYotsuba) miss.push(`よつばの単価が出ていない項目 ${c.missingYotsuba}件`);
    if (c.missingMarket) miss.push(`世の中の相場が入っていない項目 ${c.missingMarket}件`);
    if (!miss.length) return '';
    return `<br><span style="color:#8A560F;font-weight:700">${miss.join('・')}。</span>`
      + 'その項目は片方だけなので比べられません。くわしくを開いて直せます。';
  }

  function originHtml() {
    const g = rough.lastGenerate;
    if (!g || !g.source) return '';
    const ai = g.source === 'ai';
    const read = g.photosRead;
    const photoNote = !g.photosSent ? '写真なし'
      : read === 0 ? `写真${g.photosSent}枚は読めませんでした`
        : read != null && read < g.photosSent ? `写真${g.photosSent}枚のうち${read}枚を読みました`
          : `写真${g.photosSent}枚を読みました`;
    const gap = ai ? coverageNote(g) : '';
    // 片方だけが残っているときは、AIでも山吹（気づいてほしい色）にする
    const warn = !ai || !!gap;
    return `
      <div style="display:flex;align-items:flex-start;gap:8px;margin-top:8px;padding:9px 12px;border-radius:6px;
        background:${warn ? '#FBF2E4' : '#EAF0F6'};border:1px solid ${warn ? '#E0CDA6' : '#C3D3E4'}">
        <span style="font-size:15px;flex:none;display:grid;place-items:center;color:${warn ? '#BA7517' : '#1B3A5C'}">
          ${warn ? icons.warning : icons.checkCircle}</span>
        <div style="flex:1;min-width:0;font-size:12px;line-height:1.7;color:${warn ? '#7A5A18' : '#1B3A5C'}">
          ${ai
            ? `<b>AIが出した項目です。</b>${photoNote}。よつばの単価と世の中の相場を並べています。${gap}`
            : `<b>ひな形から出した項目です。</b>AIにつながらなかったので、決まった並びを出しています。
               世の中の相場は入りません。${g.why ? `<br>理由: ${esc(g.why)}` : ''}`}
        </div>
      </div>`;
  }

  // 【順番が大事】先に出す。出せてから消す。
  //   先に消すと、AIにつながらなかったときに「項目が消えたまま、何も出ない」になる。
  //   現場は手が止まり、消えたことも見えない。芯2（止めない）と芯4（止まったものが見える）に反する。
  //   AIで出せなかったときは黙って諦めず、ひな形に戻して先へ進めるようにする。
  async function generate() {
    if (busy) return;
    const ai = isAiAvailable();
    if (items.length && !(await confirmDialog(
      `いまの ${items.length}件 を消して、${ai ? '出しなおします' : 'ひな形から出しなおします'}。よろしいですか?`,
      '出しなおす'))) return;
    busy = true; paint();
    // 押した直後から「動いているもの」を出す。ここから先は待ち時間が長い
    if (ai) openWorkVeil((rough.photos || []).length);
    try {
      let res;
      let fellBack = false;
      let why = '';
      try {
        res = await generateItems({
          workType: rough.workType, oneLiner: rough.oneLiner, photos: rough.photos || [],
          // 【職種の呼び方を渡す】よつばの単価は「職種名 → 円/工数」の表を引いて出す。
          // AIが表に無い名前（例「配管工」）を返すと単価が引けず、金額が黙って消える。
          // 単価そのものは渡さない。渡すのは名前だけ。
          // この見積に効いている一覧（会社の標準→元請け→この見積、を解いたあと）を渡す。
          trades: (calcAll().unitRates.trades || []).map((t) => t.name).filter(Boolean),
        });
      } catch (e) {
        // ひな形のときに失敗したなら、それは本当の異常。握りつぶさない
        if (!ai) throw e;
        console.error('AIで出せませんでした。ひな形に戻します:', e);
        why = String(e && e.message || e).slice(0, 120);
        res = generateByTemplate({ workType: rough.workType });
        fellBack = true;
      }
      // ここまで来たら必ず出せる。ここで初めて古い項目を消す
      if (items.length) await Promise.all(items.map((it) => deleteItem(roughId, it.id)));
      await addItems(roughId, res.items);
      for (const qq of (res.questions || [])) await addQuestion(roughId, qq);
      // 【出どころを見積本体に残す】トーストは消える。一覧の上にいつでも出す（芯4）
      const sent = fellBack ? (rough.photos || []).length : (res.photosSent || 0);
      try {
        await saveGenerateResult(roughId, {
          source: fellBack ? 'template' : res.source,
          photosSent: sent,
          photosRead: fellBack ? null : res.photosRead,
          items: res.items.length,
          by: local.get('staff', ''),
          why,
          coverage: fellBack ? null : res.coverage,
        });
      } catch (e) { console.warn('出どころを残せませんでした:', e); }
      // 【写真が読めていないことを黙らせない】
      // 写真を渡したのに1枚も読めていないなら、それは出た項目の質に直結する。
      // 黙っていると「AIが写真を見てくれない」が原因不明のまま残る（芯4）。
      const gotNone = !fellBack && sent && res.photosRead === 0;
      const gotSome = !fellBack && sent && res.photosRead > 0 && res.photosRead < sent;
      // 片方だけの項目が残ったら、写真の話より先にそれを言う。金額に直結するのはこちら
      const c = !fellBack ? res.coverage : null;
      const half = c ? (c.missingYotsuba || 0) + (c.missingMarket || 0) : 0;
      // 定尺が引けなかった材料も黙らせない。総量のままだと発注の本数が出せない
      const noStock = !fellBack ? (res.materials?.unresolved || 0) : 0;
      toast(fellBack
        ? `AIにつながらないので、ひな形から${res.items.length}項目を出しました`
        : half
          ? `${res.items.length}項目を出しました。うち${half}件は よつばの単価 か 相場 の片方だけです`
          : noStock
            ? `${res.items.length}項目を出しました。うち${noStock}件は定尺が分からず、長さのままです`
            : gotNone
              ? `写真${sent}枚が読めませんでした。写真なしで${res.items.length}項目を出しています`
              : gotSome
                ? `写真${sent}枚のうち${res.photosRead}枚だけ読めました。${res.items.length}項目を出しました`
                : `${res.items.length}項目を出しました。人数と時間を直してください`);
    } catch (e) {
      console.error(e);
      toast(e.message || '項目を出せませんでした');
    } finally { closeWorkVeil(); busy = false; paint(); }
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

  // 画面を離れるとき。開いたままの写真ビューアも一緒に閉じる
  // （閉じないと、別の画面の上に全画面の写真が残る）
  return () => {
    if (viewer) viewer.close();
    closeWorkVeil();          // 待ちの画面も一緒に閉じる（別の画面の上に残らないように）
    stops.forEach((s) => s && s());
  };
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
