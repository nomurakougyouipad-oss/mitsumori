// ============================================================
// 写真を大きく見る（ピンチで拡大・左右で送る）
//
// 【なぜ自前で拡大するか】
//   index.html の viewport は user-scalable=no・maximum-scale=1、
//   app.css は * { touch-action: manipulation }。ブラウザの拡大は殺してある。
//   画面ぜんたいが拡大すると、ヘッダーもボタンも一緒に動いて操作できなくなるため。
//   だからここだけ、写真そのものを transform で拡大する。
//   拡大するのは写真だけなので、上下のボタンは動かない。
//
// 【指の割り当て】
//   指2本          … 拡大・縮小。2本の真ん中を軸にする（見ている所が逃げない）
//   指1本（等倍）  … 左右になぞって 次／前 の写真
//   指1本（拡大中）… 写真の中を動かす。※拡大中は送らない。
//                     銘板を読んでいる最中に指がすべって隣へ飛ぶ方が困る
//   2回たたく      … 等倍 ⇔ 3倍
//
// 【上限6倍の根拠】
//   写真は送るときに長辺2000pxへ縮めてある（rough-store.js の shrinkImage）。
//   390pxの画面だと約5倍で元の粒に届く。それ以上はぼやけるだけなので6倍で止める。
//   継手の形と銘板の文字は、これで読める。
//
// 【この画面から Firestore を触らない】
//   消すのは onDelete に任せる。呼ぶ側（screen-rough.js）が消して、
//   写真が減ったことを refresh() で伝え返す。
//   そのおかげでこのファイルは Firebase 無しで動き、
//   tools/test-photo-viewer.html から実物のまま試せる。
//   ※写しを作って試すと、写しの方だけ直って本体が古いまま残る。
// ============================================================

import { esc } from './util.js?v=33';
import { icons } from './icons.js?v=33';
import { confirmDialog } from './ui.js?v=33';

const ZOOM_MAX = 6;
const ZOOM_TAP = 3;          // 2回たたいたときの倍率
const SWIPE_COMMIT = 56;     // これだけ横へ動かしたら送る（px）
const SLIDE_MS = 160;        // 送るときに滑る時間

// PDFで来た図面は <img> では出せない。潰れた画を出さずにPDFの札を出して、
// 別のアプリで開ける道を出す。無言で壊れて見えるのが一番悪い（芯4）。
export const isPdf = (p) => /\.pdf(\?|$)/i.test(p?.path || '') || /\.pdf(\?|$)/i.test(p?.url || '');

// photos    … [{ path, url, role }]
// startPath … 最初に出す1枚
// onDelete  … 消すと決めたときに呼ぶ。async 可。中で Firestore を触るのは呼ぶ側
// 戻り値 … { refresh(photos), close() }
export function openPhotoViewer({ photos, startPath, onDelete, onClose } = {}) {
  let list = (photos || []).slice();
  if (!list.length) return null;
  let i = Math.max(0, list.findIndex((p) => p.path === startPath));

  const root = document.getElementById('modal-root') || document.body;
  const v = document.createElement('div');
  v.className = 'photo-view';
  v.innerHTML = `
    <div class="pv-top">
      <span><span class="n" id="pv-i">1</span> / <span class="n" id="pv-n">1</span>
        <span id="pv-role" style="margin-left:8px"></span></span>
      <span class="zoom" id="pv-z"></span>
    </div>
    <div class="pv-stage" id="pv-stage">
      <div class="pv-track" id="pv-track">
        <div class="pv-slot"></div><div class="pv-slot"></div><div class="pv-slot"></div>
      </div>
    </div>
    <div class="pv-bar">
      <button class="btn btn-danger" id="pv-del">この写真を消す</button>
      <button class="btn" id="pv-x" style="color:#fff;border-color:#fff;background:transparent">閉じる</button>
    </div>`;
  root.appendChild(v);

  const stage = v.querySelector('#pv-stage');
  const track = v.querySelector('#pv-track');
  const slots = [...v.querySelectorAll('.pv-slot')];

  let s = 1, tx = 0, ty = 0;                 // いま見ている写真の 倍率・ずれ
  let s0 = 1, tx0 = 0, ty0 = 0;              // 指を置いた瞬間の値
  let d0 = 0, mx0 = 0, my0 = 0;              // 指2本の間隔と真ん中
  let sx = 0, sy = 0;                        // 指1本を置いた場所
  let dx = 0;                                // 送りの横のずれ
  let mode = null;                           // 'zoom' | 'pan' | 'swipe'
  let sliding = false;
  let lastTap = 0, lastTapX = 0;
  const pts = new Map();

  const curImg = () => slots[1].querySelector('img');

  // 3枠に 前・いま・次 を入れる。前後が無い枠は空。先読みは1枚ずつだけ（電波が悪い現場）
  function fillSlots() {
    [-1, 0, 1].forEach((d, k) => {
      const p = list[i + d];
      slots[k].innerHTML = !p ? ''
        : isPdf(p)
          ? `<div class="pv-pdf">${icons.fileText}
               <div>PDFの図面です。<br>この画面では大きくできません。</div>
               <button class="btn" data-pdf="${esc(p.url)}"
                 style="color:#fff;border-color:#fff;background:transparent">別のアプリで開く</button></div>`
          : `<img src="${esc(p.url)}" alt="">`;
    });
    v.querySelectorAll('[data-pdf]').forEach((b) => b.addEventListener('click', () => {
      window.open(b.dataset.pdf, '_blank', 'noopener');
    }));
    v.querySelector('#pv-i').textContent = String(i + 1);
    v.querySelector('#pv-n').textContent = String(list.length);
    v.querySelector('#pv-role').textContent = list[i]?.role === '図面' ? '図面' : '';
  }

  function applyZoom() {
    const img = curImg();
    if (img) img.style.transform = `translate3d(${tx}px,${ty}px,0) scale(${s})`;
    v.querySelector('#pv-z').textContent = s > 1.02 ? `${s.toFixed(1)}倍` : '';
  }
  function applyTrack(animate) {
    track.style.transition = animate ? `transform ${SLIDE_MS}ms ease-out` : '';
    track.style.transform = `translate3d(calc(-100% + ${dx}px),0,0)`;
  }
  function resetZoom() { s = 1; tx = 0; ty = 0; applyZoom(); }

  // 拡大した写真がどこまで動かせるか。端まで来たら止める（黒い所を見せない）
  function clampPan() {
    const img = curImg();
    if (!img) return;
    const maxX = Math.max(0, (img.offsetWidth * s - stage.clientWidth) / 2);
    const maxY = Math.max(0, (img.offsetHeight * s - stage.clientHeight) / 2);
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
  }

  function go(step) {
    if (sliding) return;
    const next = i + step;
    if (next < 0 || next >= list.length) { dx = 0; applyTrack(true); return; }
    sliding = true;
    // いったん隣まで滑らせてから、枠を入れ替えて真ん中へ戻す。
    // 戻すときは transition を切る（画がひと呼吸ぶん逆走して見えるため）
    dx = -step * stage.clientWidth;
    applyTrack(true);
    const done = () => {
      if (!sliding) return;
      sliding = false;
      track.removeEventListener('transitionend', done);
      i = next; dx = 0;
      resetZoom();
      applyTrack(false);
      fillSlots();
      applyZoom();
    };
    track.addEventListener('transitionend', done);
    setTimeout(done, SLIDE_MS + 100);   // 保険（transitionendが来ない端末でも必ず戻す）
  }

  // ---------- 指 ----------
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  stage.addEventListener('pointerdown', (e) => {
    // 【必ず try で囲む】setPointerCapture は投げることがある。
    // 投げると pointerdown の残りが丸ごと死に、指を置いても何も起きなくなる。
    // 拡大も送りも黙って効かなくなるので、原因がまず分からない。
    // 掴み損ねても指はこの要素の上にあるので、実害は無い。
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* 掴めなくても続ける */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      d0 = dist(a, b) || 1;
      mx0 = (a.x + b.x) / 2; my0 = (a.y + b.y) / 2;
      s0 = s; tx0 = tx; ty0 = ty;
      dx = 0; applyTrack(false);
      mode = 'zoom';
    } else if (pts.size === 1) {
      sx = e.clientX; sy = e.clientY;
      tx0 = tx; ty0 = ty;
      mode = null;                 // 動かしてみるまで、送りか移動かを決めない
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pts.size >= 2 && mode === 'zoom') {
      const [a, b] = [...pts.values()];
      const d = dist(a, b) || 1;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      s = Math.min(ZOOM_MAX, Math.max(1, s0 * (d / d0)));
      // 指の真ん中にある点が、指の真ん中に居続けるようにずらす
      const r = stage.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      tx = (mx - cx) - ((mx0 - cx) - tx0) * (s / s0);
      ty = (my - cy) - ((my0 - cy) - ty0) * (s / s0);
      clampPan();
      applyZoom();
      return;
    }
    if (pts.size !== 1) return;

    const ddx = e.clientX - sx, ddy = e.clientY - sy;
    if (mode === null) {
      if (Math.abs(ddx) < 6 && Math.abs(ddy) < 6) return;
      mode = s > 1.02 ? 'pan' : 'swipe';
    }
    if (mode === 'pan') {
      tx = tx0 + ddx; ty = ty0 + ddy;
      clampPan(); applyZoom();
    } else if (mode === 'swipe') {
      // 端では重くする。これ以上は無いことが指で分かる
      const atEnd = (ddx > 0 && i === 0) || (ddx < 0 && i === list.length - 1);
      dx = atEnd ? ddx * 0.25 : ddx;
      applyTrack(false);
    }
  });

  function endPointer(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);

    if (pts.size === 1 && mode === 'zoom') {
      // 指を1本離した。残った指で続けて動かせるよう、基準を取り直す
      const [a] = [...pts.values()];
      sx = a.x; sy = a.y; tx0 = tx; ty0 = ty;
      mode = 'pan';
      return;
    }
    if (pts.size > 0) return;

    if (mode === 'swipe') {
      if (Math.abs(dx) > SWIPE_COMMIT) go(dx < 0 ? 1 : -1);
      else { dx = 0; applyTrack(true); }
    } else if (mode === 'zoom' || mode === 'pan') {
      if (s <= 1.02) resetZoom(); else { clampPan(); applyZoom(); }
    } else {
      // 動かしていない＝たたいた。2回続けてなら拡大／等倍
      const now = e.timeStamp || Date.now();
      if (now - lastTap < 320 && Math.abs(e.clientX - lastTapX) < 30) {
        lastTap = 0;
        if (s > 1.02) resetZoom();
        else {
          const r = stage.getBoundingClientRect();
          s = ZOOM_TAP;
          tx = -(e.clientX - (r.left + r.width / 2)) * (s - 1);
          ty = -(e.clientY - (r.top + r.height / 2)) * (s - 1);
          clampPan(); applyZoom();
        }
      } else { lastTap = now; lastTapX = e.clientX; }
    }
    mode = null;
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  // ---------- 閉じる・消す ----------
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    v.remove();
    onClose?.();
  }
  v.querySelector('#pv-x').addEventListener('click', close);
  v.querySelector('#pv-del').addEventListener('click', async () => {
    const p = list[i];
    if (!p || !onDelete) return;
    if (!(await confirmDialog('この写真を消しますか?', '消す'))) return;
    await onDelete(p);
    // 一覧が減ったことは refresh() で戻ってくる。ここでは閉じない
  });

  fillSlots();
  applyTrack(false);
  applyZoom();

  return {
    // 写真が増減したら開いたまま追いつく（消した直後・別の端末から足された時）
    // 【拡大を勝手に戻さない】呼ぶ側の再描画は項目を直すたびに走る。
    // 毎回作り直すと、銘板を拡大して見ている最中に等倍へ戻ってしまう。
    // 写真の顔ぶれが実際に変わったときだけ手を入れる。
    refresh(next) {
      const now = next || [];
      if (now.length === list.length && now.every((p, k) => p.path === list[k].path)) return;
      const curPath = list[i]?.path;
      list = now.slice();
      if (!list.length) { close(); return; }
      const at = list.findIndex((p) => p.path === curPath);
      i = at >= 0 ? at : Math.min(i, list.length - 1);
      sliding = false;
      resetZoom(); dx = 0; applyTrack(false); fillSlots(); applyZoom();
    },
    close,
  };
}
