// ============================================================
// 見積アプリ — 画面制御（ルーター・シェル・担当者選択）
// ルート: #home / #estimates / #search / #settings / #est/{id}
// ============================================================

import { esc, local } from './util.js?v=11';
import { icons } from './icons.js?v=11';
import { toast, closeAllOverlays } from './ui.js?v=11';
import { db, ready, collection, addDoc } from './firebase.js?v=11';
import { startSubscriptions, onCacheChange, cache } from './store.js?v=11';
import { renderHome, renderEstimatesTab } from './screen-home.js?v=11';
import { renderEstScreen, openCoverPage } from './screen-est.js?v=11';
import { renderSearchTab } from './screen-order.js?v=11';
import { renderSettingsTab } from './screen-settings.js?v=11';

const state = {
  staff: local.get('staff', ''),
  tab: 'home',
};

// ---------- 起動画面（スプラッシュ） ----------
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

// ---------- ルーター ----------
const TABS = [
  { id: 'home', label: 'ホーム', icon: 'home' },
  { id: 'estimates', label: '見積', icon: 'note' },
  { id: 'search', label: 'さがす', icon: 'search' },
  { id: 'settings', label: '設定', icon: 'gear' },
];

let cleanup = null;     // 現在の画面の購読解除
let currentRoute = '';

function parseRoute() {
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('est/')) return { kind: 'est', id: h.slice(4).split('/')[0] };
  return { kind: 'tab', id: TABS.some((t) => t.id === h) ? h : 'home' };
}

window.addEventListener('hashchange', () => { closeAllOverlays(); render(); });

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

function tabbarHtml(active) {
  return `
    <nav class="tabbar">
      ${TABS.map((t) => `
        <a href="#${t.id}" class="${active === t.id ? 'on' : ''}">
          ${active === t.id ? icons[t.icon + 'Fill'] : icons[t.icon]}
          <span>${t.label}</span>
        </a>`).join('')}
    </nav>`;
}

// ---------- 担当者の選択 ----------
let staffModalOpen = false;
function openStaffModal(closable = true) {
  const root = document.getElementById('modal-root');
  staffModalOpen = true;
  const listHtml = () => cache.staff.length
    ? cache.staff.map((s) => `
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

  const close = () => { staffModalOpen = false; root.innerHTML = ''; };
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
    if (cache.staff.some((s) => s.name === name)) { toast('同じ名前がすでにあります'); return; }
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
  if (cleanup) { cleanup(); cleanup = null; }
  const route = parseRoute();
  currentRoute = route.kind + '/' + route.id;
  const app = document.getElementById('app');

  if (route.kind === 'est') {
    app.innerHTML = '<div id="est-root" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>' + tabbarHtml('estimates');
    cleanup = renderEstScreen(document.getElementById('est-root'), route.id);
    // 新規作成直後は表紙から
    if (sessionStorage.getItem('openCover') === route.id) {
      sessionStorage.removeItem('openCover');
      let opened = false;
      const tryOpen = () => {
        const est = cache.estimates.find((e) => e.id === route.id);
        if (est && !opened) { opened = true; openCoverPage(route.id, () => cache.estimates.find((e) => e.id === route.id)); }
      };
      tryOpen();
      if (!opened) setTimeout(tryOpen, 600);
    }
    return;
  }

  state.tab = route.id;
  app.innerHTML = headerHtml() + '<div id="tab-root" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>' + tabbarHtml(state.tab);
  document.getElementById('staff-btn').addEventListener('click', () => openStaffModal());
  const rootEl = document.getElementById('tab-root');

  if (state.tab === 'home') renderHome(rootEl);
  else if (state.tab === 'estimates') renderEstimatesTab(rootEl);
  else if (state.tab === 'search') renderSearchTab(rootEl);
  else renderSettingsTab(rootEl);
}

// 設定画面からの担当者切替
document.addEventListener('open-staff-modal', () => openStaffModal());

// キャッシュ変化で再描画（入力中のオーバーレイは崩さない）
onCacheChange(() => {
  const route = parseRoute();
  if (route.kind === 'tab' && !staffModalOpen && !document.querySelector('.fullpage')) render();
  if (staffModalOpen) openStaffModal(!!state.staff);
});

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
  startSubscriptions();
  // 初回起動: 担当者を選ばせる（閉じられないモーダル）
  if (!state.staff) {
    setTimeout(() => { if (!state.staff) openStaffModal(false); }, 800);
  }
}

main();
