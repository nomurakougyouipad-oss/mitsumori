// ============================================================
// 見積アプリ — 画面制御（フェーズ1: シェル）
// ハッシュルーター＋下部タブ4つ（ホーム／見積／さがす／設定）
// フェーズ2以降で各画面の中身を実装する
// ============================================================

import { esc, local } from './util.js?v=1';
import { icons } from './icons.js?v=1';
import {
  db, ready,
  collection, addDoc, onSnapshot, query, orderBy,
} from './firebase.js?v=1';

// ---------- 状態 ----------
const state = {
  staff: local.get('staff', ''),   // 担当者名（端末に記憶）
  staffList: [],                   // staffコレクション
  tab: 'home',
};

// ---------- 起動画面（スプラッシュ） ----------
// 0.45秒のズームフェードで消える。最低0.8秒は表示する（README第1章）
const SPLASH_MIN_MS = 800;
const splashShownAt = Date.now();
function hideSplash() {
  const el = document.getElementById('splash');
  if (!el) return;
  const rest = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt));
  setTimeout(() => {
    el.classList.add('splash-hide');
    setTimeout(() => el.remove(), 500);
  }, rest);
}

// ---------- トースト ----------
let toastTimer = null;
export function toast(msg, undoLabel = null, onUndo = null) {
  const root = document.getElementById('toast-root');
  clearTimeout(toastTimer);
  root.innerHTML = `<div class="toast">${esc(msg)}${undoLabel ? `<span class="undo">${esc(undoLabel)}</span>` : ''}</div>`;
  if (undoLabel && onUndo) {
    root.querySelector('.undo').addEventListener('click', () => { root.innerHTML = ''; onUndo(); });
  }
  toastTimer = setTimeout(() => { root.innerHTML = ''; }, 3500);
}

// ---------- ルーター ----------
const TABS = [
  { id: 'home', label: 'ホーム', icon: 'home' },
  { id: 'estimates', label: '見積', icon: 'note' },
  { id: 'search', label: 'さがす', icon: 'search' },
  { id: 'settings', label: '設定', icon: 'gear' },
];

function currentTab() {
  const h = location.hash.replace('#', '');
  return TABS.some((t) => t.id === h) ? h : 'home';
}

window.addEventListener('hashchange', render);

// ---------- 共通部品 ----------
function headerHtml() {
  return `
    <header class="app-header">
      <div class="bar">
        <span class="wordmark">QUOTE</span>
        <button class="staff-btn" id="staff-btn">
          ${icons.user}${esc(state.staff || '担当者を選ぶ')}${icons.caretDown}
        </button>
      </div>
    </header>`;
}

function tabbarHtml() {
  return `
    <nav class="tabbar">
      ${TABS.map((t) => `
        <a href="#${t.id}" class="${state.tab === t.id ? 'on' : ''}">
          ${state.tab === t.id ? icons[t.icon + 'Fill'] : icons[t.icon]}
          <span>${t.label}</span>
        </a>`).join('')}
    </nav>`;
}

// ---------- 各画面（フェーズ1は土台のみ） ----------
function homeHtml() {
  return `
    <div class="screen">
      <div class="seg-band">
        <div class="opt on">自分の工事</div>
        <div class="opt" id="seg-all">会社全体</div>
      </div>
      <div class="badge-row">
        <div class="bdg">発注待ち<b>0</b></div>
        <div class="bdg">単価待ち<b>0</b></div>
        <div class="bdg">判断待ち<b>0</b></div>
      </div>
      <div class="scroll">
        <div class="empty">
          <div class="big">見積はまだありません</div>
          下の「＋あたらしい見積」から作れるようになります（フェーズ2で実装）
        </div>
      </div>
      <div class="bottom-action">
        <button class="btn btn-primary btn-block btn-big" id="new-estimate">${icons.plus}あたらしい見積</button>
      </div>
    </div>`;
}

function estimatesHtml() {
  return `
    <div class="screen"><div class="scroll">
      <div class="empty">
        <div class="big">見積の入力（フェーズ2で実装）</div>
        表紙・材料の検索・手打ち行・単価待ち・労務費・移動費・外注費をここに作ります
      </div>
    </div></div>`;
}

function searchHtml() {
  return `
    <div class="screen"><div class="scroll">
      <div class="empty">
        <div class="big">案件をさがす（フェーズ3で実装）</div>
        工事名・宛先・注番・担当者・期間で検索。過去の見積のコピー、加工品の実績検索もここです
      </div>
    </div></div>`;
}

function settingsHtml() {
  return `
    <div class="screen"><div class="scroll">
      <div class="sec-head"><span class="ttl">担当者</span><span class="rule"></span></div>
      <div class="card" id="staff-change" style="cursor:pointer">
        <div class="ttl">${esc(state.staff || '未選択')}</div>
        <div class="meta">タップして切り替える</div>
      </div>
      <div class="sec-head"><span class="ttl">マスターと率</span><span class="rule"></span></div>
      <div class="empty" style="padding:24px">
        率の設定・単価マスター・取引先・仕入先・常設注番・集計表の読み込みは<br>フェーズ4で実装します
      </div>
      <div class="sec-head"><span class="ttl">システム</span><span class="rule"></span></div>
      <div class="card" style="cursor:pointer" id="setup-check">
        <div class="ttl">接続テスト</div>
        <div class="meta">Firebaseとの接続を確認する</div>
      </div>
    </div></div>`;
}

// ---------- 担当者の選択（初回に選んで端末に記憶） ----------
function openStaffModal(closable = true) {
  const root = document.getElementById('modal-root');
  const listHtml = () => state.staffList.length
    ? state.staffList.map((s) => `
        <div class="pick ${s.name === state.staff ? 'on' : ''}" data-name="${esc(s.name)}">${esc(s.name)}</div>`).join('')
    : '<div class="empty" style="padding:16px">まだ登録がありません。下の欄から追加してください</div>';

  root.innerHTML = `
    <div class="modal-back" id="staff-back">
      <div class="modal">
        <div class="modal-head">担当者を選ぶ${closable ? '<button class="x" id="staff-x">×</button>' : ''}</div>
        <div class="modal-body">
          <div class="pick-list" id="staff-list">${listHtml()}</div>
          <div class="field">
            <label>名前を追加</label>
            <div style="display:flex;gap:8px">
              <input class="input" id="staff-new" placeholder="例：野村" autocomplete="off">
              <button class="btn" id="staff-add" style="flex:none">追加</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const close = () => { root.innerHTML = ''; };
  if (closable) {
    document.getElementById('staff-x').addEventListener('click', close);
    document.getElementById('staff-back').addEventListener('click', (e) => {
      if (e.target.id === 'staff-back') close();
    });
  }

  document.getElementById('staff-list').addEventListener('click', (e) => {
    const el = e.target.closest('.pick');
    if (!el) return;
    state.staff = el.dataset.name;
    local.set('staff', state.staff);
    close();
    render();
  });

  document.getElementById('staff-add').addEventListener('click', async () => {
    const input = document.getElementById('staff-new');
    const name = input.value.trim();
    if (!name) return;
    if (state.staffList.some((s) => s.name === name)) { toast('同じ名前がすでにあります'); return; }
    try {
      await addDoc(collection(db, 'staff'), { name });
      state.staff = name;
      local.set('staff', name);
      close();
      render();
      toast(`担当者「${name}」を登録しました`);
    } catch (err) {
      console.error(err);
      toast('登録に失敗しました。電波を確認してください');
    }
  });
}

// ---------- 描画 ----------
function render() {
  state.tab = currentTab();
  const app = document.getElementById('app');
  const bodyHtml = { home: homeHtml, estimates: estimatesHtml, search: searchHtml, settings: settingsHtml }[state.tab]();
  app.innerHTML = headerHtml() + bodyHtml + tabbarHtml();

  document.getElementById('staff-btn').addEventListener('click', () => openStaffModal());
  if (state.tab === 'home') {
    document.getElementById('new-estimate').addEventListener('click', () => toast('見積の入力はフェーズ2で実装します'));
    document.getElementById('seg-all').addEventListener('click', () => toast('会社全体の一覧はフェーズ2で実装します'));
  }
  if (state.tab === 'settings') {
    document.getElementById('staff-change').addEventListener('click', () => openStaffModal());
    document.getElementById('setup-check').addEventListener('click', () => { location.href = './tools/setup-check.html'; });
  }
}

// ---------- 起動 ----------
async function main() {
  render();
  hideSplash();

  try {
    await ready;
  } catch (err) {
    document.getElementById('app').insertAdjacentHTML('afterbegin',
      '<div class="conn-error">接続できませんでした。電波の届く場所でもう一度開いてください</div>');
    return;
  }

  // 担当者マスタを購読（名前順）。初回起動で未選択ならモーダルを開く
  onSnapshot(query(collection(db, 'staff'), orderBy('name')), (snap) => {
    state.staffList = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const back = document.getElementById('staff-back');
    if (back) openStaffModal(!!state.staff);      // モーダル表示中なら一覧を最新化
    else if (!state.staff) openStaffModal(false); // 初回は閉じられないモーダルで選ばせる
  }, (err) => console.error('staffの購読に失敗:', err));
}

main();
