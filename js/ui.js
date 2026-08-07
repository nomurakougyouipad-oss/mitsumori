// ============================================================
// 共通UI部品 — 全画面オーバーレイ・テンキー・トースト
// ============================================================

import { esc } from './util.js?v=33';

// ---------- トースト ----------
let toastTimer = null;
export function toast(msg, undoLabel = null, onUndo = null) {
  const root = document.getElementById('toast-root');
  clearTimeout(toastTimer);
  root.innerHTML = `<div class="toast">${esc(msg)}${undoLabel ? `<span class="undo">${esc(undoLabel)}</span>` : ''}</div>`;
  if (undoLabel && onUndo) {
    root.querySelector('.undo').addEventListener('click', () => { root.innerHTML = ''; onUndo(); });
  }
  toastTimer = setTimeout(() => { root.innerHTML = ''; }, 4000);
}

// ---------- 作り直してもスクロール位置を保つ ----------
// 選択のたびに ov.el.innerHTML を丸ごと入れ替える画面が多い。
// 入れ替えると、実際にスクロールしている要素（.page-body）ごと作り直されるので
// 位置が先頭に戻る。下の方の項目を選ぶたびに画面が上に飛んでしまう。
// 入れ替えの前後で scrollTop を持ち回って、見ていた場所に留める。
// ※ 中身が短くなったときはブラウザが自動で詰めるので、それ以上の調整はしない
// スクロールしている要素は、オーバーレイは .page-body、画面本体は .scroll。
// 写真から見積は .scroll なので、.page-body だけを見ていたころは
// ＋8h を押すたびに一覧の先頭へ飛んでいた。両方を見る。
const SCROLLER = '.page-body, .scroll';
export function setHtmlKeepScroll(root, html) {
  const prev = root.querySelector(SCROLLER)?.scrollTop || 0;
  root.innerHTML = html;
  if (prev) {
    const body = root.querySelector(SCROLLER);
    if (body) body.scrollTop = prev;
  }
}

// ---------- 画面幅の判定（CSSのブレークポイントと同じ値を使うこと） ----------
// 〜767px スマホ／768〜1023px タブレット／1024px〜 PC（事務所の作業が主）
// レイアウトが根本から変わる画面（判断待ちの2カラム等）はJS側でも切り替える。
export const PC_QUERY = window.matchMedia('(min-width: 1024px)');
export const isPc = () => PC_QUERY.matches;
// 幅が境界をまたいだら描き直す。戻り値を呼ぶと購読を解除する
export function onPcChange(fn) {
  PC_QUERY.addEventListener('change', fn);
  return () => PC_QUERY.removeEventListener('change', fn);
}

// ---------- 検索入力の共通処理（iPhone対策） ----------
// リアルタイム絞り込みの検索欄はすべてこれを使うこと。約束は2つ:
// ① inputノードは一度だけ生成し、絞り込みの再描画で作り直さない
//    （inputをinnerHTMLで再生成→focusし直すと、iOSはキーボードを
//      既定（かな）で出し直す・変換中の文字が二重に入る）
// ② 日本語IMEの変換中（compositionstart〜compositionend）は
//    絞り込みを走らせない。確定した時点で1回だけ走らせる
export function bindSearch(input, onQuery) {
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; onQuery(input.value); });
  input.addEventListener('input', (e) => {
    if (composing || e.isComposing) return;
    onQuery(input.value);
  });
}

// ---------- 全画面オーバーレイ（材料を追加・表紙など） ----------
// 戻り値のelにinnerHTMLを入れて使う。close()で閉じる。
// narrow: true …… 現場が使う入力系のページ。広い画面では中央720pxに寄せる
//                  （事務所のページは幅を使い切るので指定しない）
const overlayStack = [];
export function openOverlay({ narrow = false } = {}) {
  const root = document.getElementById('modal-root');
  const el = document.createElement('div');
  el.className = narrow ? 'fullpage narrow' : 'fullpage';
  root.appendChild(el);
  overlayStack.push(el);
  return {
    el,
    close() {
      const i = overlayStack.indexOf(el);
      if (i >= 0) overlayStack.splice(i, 1);
      el.remove();
    },
  };
}
export function closeAllOverlays() {
  while (overlayStack.length) overlayStack.pop().remove();
}

// ---------- テンキー（数量のその場編集） ----------
// ページを動かさず下からシートで出す。完了で onDone(数値 or null)
// hint … 単位の数え方を一言だけ添える（例「1工数 ＝ 8時間」）。
// 数字の意味が数え方に依るものは、入れる場所に書いておかないと間違える。
export function openNumpad({ title = '数量', value = '', unit = '', allowDecimal = true, hint = '', onDone }) {
  const root = document.getElementById('modal-root');
  const back = document.createElement('div');
  back.className = 'numpad-back';
  let buf = String(value ?? '');
  back.innerHTML = `
    <div class="numpad">
      <div class="np-head">
        <span class="np-title">${esc(title)}</span>
        <span class="np-value"><b id="np-val"></b><span class="np-unit">${esc(unit)}</span></span>
      </div>
      ${hint ? `<div style="font-size:12px;color:var(--muted);padding:0 4px 8px">${esc(hint)}</div>` : ''}
      <div class="np-grid">
        ${[7, 8, 9, 4, 5, 6, 1, 2, 3].map((n) => `<button class="np-key" data-k="${n}">${n}</button>`).join('')}
        <button class="np-key" data-k="." ${allowDecimal ? '' : 'disabled'}>.</button>
        <button class="np-key" data-k="0">0</button>
        <button class="np-key" data-k="bs">⌫</button>
      </div>
      <div class="np-actions">
        <button class="btn np-cancel">やめる</button>
        <button class="btn btn-primary np-ok">完了</button>
      </div>
    </div>`;
  root.appendChild(back);

  const valEl = back.querySelector('#np-val');
  let touched = false; // 最初の1打で既存値を置き換える（追記だと 1→12 の誤入力になる）
  const paint = () => { valEl.textContent = buf === '' ? '0' : buf; };
  paint();

  back.addEventListener('click', (e) => {
    const key = e.target.closest('.np-key');
    if (key) {
      const k = key.dataset.k;
      if (!touched && k !== 'bs') { buf = ''; touched = true; }
      if (k === 'bs') { buf = buf.slice(0, -1); touched = true; }
      else if (k === '.') { if (allowDecimal && !buf.includes('.')) buf = (buf === '' ? '0' : buf) + '.'; }
      else { if (buf === '0') buf = ''; if (buf.replace('.', '').length < 7) buf += k; }
      paint();
      return;
    }
    if (e.target.closest('.np-ok')) {
      back.remove();
      const n = parseFloat(buf);
      onDone(isFinite(n) ? n : null);
      return;
    }
    if (e.target.closest('.np-cancel') || e.target === back) back.remove();
  });
}

// ---------- 文字入力ダイアログ ----------
// 数字は openNumpad、文字は こちら。メモや日付など短い文字列を入れる。
// iOS対策として input は一度だけ作り、描き直さない（ui.js の bindSearch と同じ理由）。
export function openTextInput({ title = '入力', value = '', placeholder = '', hint = '', multiline = false, onDone }) {
  const root = document.getElementById('modal-root');
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal"><div class="modal-head">${esc(title)}<button class="x" id="ti-x">×</button></div>
    <div class="modal-body">
      ${multiline
        ? `<textarea id="ti-v" rows="4" placeholder="${esc(placeholder)}"
             style="width:100%;font-size:16px;padding:10px;border:1px solid var(--line);border-radius:6px;line-height:1.6"></textarea>`
        : `<input id="ti-v" placeholder="${esc(placeholder)}" autocomplete="off"
             style="width:100%;font-size:16px;padding:12px;border:1px solid var(--line);border-radius:6px">`}
      ${hint ? `<div style="font-size:12px;color:var(--muted);line-height:1.7">${esc(hint)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn" style="flex:1;min-height:44px" id="ti-cancel">やめる</button>
        <button class="btn btn-primary" style="flex:1;min-height:44px" id="ti-ok">決定</button>
      </div>
    </div></div>`;
  root.appendChild(back);
  const input = back.querySelector('#ti-v');
  input.value = value ?? '';
  const close = () => back.remove();
  back.querySelector('#ti-x').addEventListener('click', close);
  back.querySelector('#ti-cancel').addEventListener('click', close);
  back.querySelector('#ti-ok').addEventListener('click', () => { const v = input.value.trim(); close(); onDone(v); });
  setTimeout(() => input.focus(), 30);
}

// ---------- 確認ダイアログ ----------
export function confirmDialog(message, okLabel = 'OK') {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal">
        <div class="modal-body" style="padding-top:22px">
          <div style="font-size:15px;line-height:1.7;white-space:pre-line">${esc(message)}</div>
          <div style="display:flex;gap:8px;margin-top:4px">
            <button class="btn" style="flex:1" data-r="0">やめる</button>
            <button class="btn btn-primary" style="flex:1" data-r="1">${esc(okLabel)}</button>
          </div>
        </div>
      </div>`;
    root.appendChild(back);
    back.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b) { back.remove(); resolve(b.dataset.r === '1'); }
    });
  });
}
