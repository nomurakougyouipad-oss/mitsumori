// ============================================================
// 見積アプリ — 画面制御（ルーター・シェル・担当者選択）
// ルート: #home / #estimates / #search / #settings / #est/{id}
// ============================================================

import { esc, local } from './util.js?v=33';
import { icons } from './icons.js?v=33';
import { toast, closeAllOverlays } from './ui.js?v=33';
import { ready } from './firebase.js?v=33';
import { startSubscriptions, onCacheChange, cache, createEstimate, addStaff } from './store.js?v=33';
import { renderHome, renderEstimatesTab } from './screen-home.js?v=33';
import { renderEstScreen, openCoverPage, openConfirmPage } from './screen-est.js?v=33';
import { renderSearchTab } from './screen-order.js?v=33';
import { renderSettingsTab } from './screen-settings.js?v=33';

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
  // #est/{id} … 明細一覧 ／ #est/{id}/confirm … 確認画面を開いた状態で入る
  //（見積書のページから「アプリへ戻る」で帰ってくるときに使う）
  if (h.startsWith('est/')) {
    const parts = h.slice(4).split('/');
    return { kind: 'est', id: parts[0], sub: parts[1] || '' };
  }
  if (TABS.some((t) => t.id === h)) return { kind: 'tab', id: h };
  // ハッシュなし（アイコンから起動した直後）は表紙を出す
  return { kind: 'cover', id: '' };
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
  // 一覧が届く前に追加させない。空の一覧を見て「まだ無い」と思って打つと重複が増える
  const loaded = cache.staffLoaded;
  const listHtml = () => (!loaded
    ? '<div class="empty" style="padding:16px">読み込み中…</div>'
    : (cache.staff.length
      ? cache.staff.map((s) => `
        <div class="pick ${s.name === state.staff ? 'on' : ''}" data-name="${esc(s.name)}">${esc(s.name)}</div>`).join('')
      : '<div class="empty" style="padding:16px">まだ登録がありません。下の欄から追加してください</div>'));

  // 再描画（他のマスタが届くたびに起きる）で入力中の文字が消えないよう引き継ぐ
  const typed = document.getElementById('staff-new')?.value || '';

  root.innerHTML = `
    <div class="modal-back" id="staff-back">
      <div class="modal">
        <div class="modal-head">担当者を選ぶ${closable ? '<button class="x" id="staff-x">×</button>' : ''}</div>
        <div class="modal-body">
          <div class="pick-list" id="staff-list">${listHtml()}</div>
          <div class="field">
            <label>名前を追加</label>
            <div style="display:flex;gap:8px">
              <input class="input" id="staff-new" placeholder="例：野村" autocomplete="off"
                value="${esc(typed)}" ${loaded ? '' : 'disabled'}>
              <button class="btn" id="staff-add" style="flex:none" ${loaded ? '' : 'disabled'}>追加</button>
            </div>
            ${loaded ? '' : '<div class="search-hint">一覧を読み込んでいます。表示されるまでお待ちください</div>'}
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

  const addBtn = document.getElementById('staff-add');
  addBtn.addEventListener('click', async () => {
    if (!cache.staffLoaded) { toast('一覧を読み込んでいます。少し待ってください'); return; }
    const input = document.getElementById('staff-new');
    const name = input.value.trim();
    if (!name) return;
    if (cache.staff.some((s) => s.name === name)) { toast('同じ名前がすでにあります'); return; }
    // 二度押しでも2件作らないよう、問い合わせている間は押せなくする
    addBtn.disabled = true;
    try {
      const id = await addStaff(name);
      if (!id) {
        toast('同じ名前がすでにあります');
        addBtn.disabled = false;
        return;
      }
      state.staff = name;
      local.set('staff', name);
      close();
      render();
      toast(`担当者「${name}」を登録しました`);
    } catch (err) {
      console.error(err);
      addBtn.disabled = false;
      toast('登録に失敗しました。電波を確認してください');
    }
  });
}

// ---------- 起動の表紙 ----------
// アプリを開いて最初の1枚。スプラッシュ（自動で消える）の後に出て、
// 押すまで待つ。タブバーもヘッダーも出さない。
// ※ 見積の「表紙の情報」ページ（openCoverPage）とは別物
function renderStartCover(app) {
  document.body.classList.remove('has-tabbar');
  app.innerHTML = `
    <div class="start-cover">
      <div class="logo">
        <div class="word">QUOTE</div>
        <div class="rule"></div>
      </div>
      <div class="acts">
        <button class="btn btn-block cover-primary" id="cv-new">あたらしい見積もり</button>
        <button class="btn btn-block cover-ghost" id="cv-list">見積もり中</button>
      </div>
    </div>`;

  app.querySelector('#cv-new').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const id = await createEstimate(local.get('staff', ''));
      sessionStorage.setItem('openCover', id);   // 新規はまず見積の表紙情報を開く
      location.hash = '#est/' + id;
    } catch (err) {
      console.error(err);
      toast('作成できませんでした。電波を確認してください');
      b.disabled = false;
    }
  });
  app.querySelector('#cv-list').addEventListener('click', () => { location.hash = '#home'; });
}

// ---------- 描画 ----------
function render() {
  if (cleanup) { cleanup(); cleanup = null; }
  const route = parseRoute();
  currentRoute = route.kind + '/' + route.id;
  const app = document.getElementById('app');

  if (route.kind === 'cover') { renderStartCover(app); return; }
  document.body.classList.add('has-tabbar');

  if (route.kind === 'est') {
    app.innerHTML = '<div id="est-root" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>' + tabbarHtml('estimates');
    cleanup = renderEstScreen(document.getElementById('est-root'), route.id);
    // 見積書（表紙HTML）から「アプリへ戻る」で帰ってきたら、確認画面を開き直す
    //（ホームやトップに飛ばさず、出ていった場所に戻す）
    if (route.sub === 'confirm') {
      openConfirmPage(route.id);
      // URLは #est/{id} に戻しておく（再描画は起こさない）
      history.replaceState(null, '', '#est/' + route.id);
    }
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
