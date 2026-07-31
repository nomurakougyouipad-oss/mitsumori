// ============================================================
// 共通UI部品 — 全画面オーバーレイ・テンキー・トースト
// ============================================================

import { esc } from './util.js?v=8';

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
const overlayStack = [];
export function openOverlay() {
  const root = document.getElementById('modal-root');
  const el = document.createElement('div');
  el.className = 'fullpage';
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
export function openNumpad({ title = '数量', value = '', unit = '', allowDecimal = true, onDone }) {
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

// ---------- 確認ダイアログ ----------
export function confirmDialog(message, okLabel = 'OK') {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal">
        <div class="modal-body" style="padding-top:22px">
          <div style="font-size:15px;line-height:1.7">${esc(message)}</div>
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
