// ============================================================
// ホーム — 自分の工事／会社全体。状態3分類のカード
// ============================================================

import { esc, YEN, fmtDateJa, local } from './util.js?v=27';
import { icons } from './icons.js?v=27';
import { toast } from './ui.js?v=27';
import { cache, createEstimate } from './store.js?v=27';
import { openOrderWaitPage, confirmDeleteEstimate } from './screen-order.js?v=27';
import { openPendingPricePage, openReviewsPage } from './screen-settings.js?v=27';

const STATUSES = ['見積中', '発注待ち', '進行中'];

export function renderHome(container, opts = {}) {
  const scopeAll = local.get('homeScope', 'mine') === 'all';

  function paint() {
    const staffName = local.get('staff', '');
    const all = cache.estimates;
    const mine = scopeAll ? all : all.filter((e) => e.staff === staffName);
    const orderWait = all.filter((e) => e.status === '発注待ち').length;
    const priceWait = all.filter((e) => (e.pendingCount || 0) > 0).length;

    const card = (e) => `
      <div class="card" data-est="${e.id}" style="cursor:pointer;position:relative">
        <button class="card-del corner" data-del="${e.id}" aria-label="この見積を削除">🗑</button>
        <div class="ttl" style="padding-right:46px">${esc(e.projectName || '（工事名なし）')}</div>
        ${e.customer ? `<div class="meta">${esc(e.customer)}</div>` : ''}
        <div class="meta num" style="margin-top:2px">${e.orderNo ? '注番 ' + esc(e.orderNo) : ''}</div>
        <div style="display:flex;align-items:flex-end;justify-content:space-between;margin-top:8px">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="yen">${YEN(e.totalFinal || 0)}</span>
            ${(e.pendingCount || 0) > 0 ? '<span class="tag-warn">⚠ 暫定</span>' : ''}
            ${e.priceFilled ? '<span class="tag-warn" style="background:var(--green)">✓ 単価が入りました</span>' : ''}
          </div>
          <span style="font-size:11.5px;color:var(--muted2)" class="num">${fmtDateJa(e.updatedAt)}</span>
        </div>
        <div class="note">税込${(e.pendingCount || 0) > 0 ? `／単価待ち ${e.pendingCount}件` : ''}</div>
      </div>`;

    const section = (st) => {
      const list = mine.filter((e) => e.status === st);
      if (!list.length) return '';
      return `
        <div class="sec-head"><span class="ttl">${st}</span><span class="cnt">${list.length}</span><span class="rule"></span></div>
        ${list.map(card).join('')}`;
    };

    container.innerHTML = `
      <div class="screen">
        <div class="seg-band">
          <div class="opt ${scopeAll ? '' : 'on'}" data-scope="mine">自分の工事</div>
          <div class="opt ${scopeAll ? 'on' : ''}" data-scope="all">会社全体</div>
        </div>
        <div class="badge-row">
          <div class="bdg" id="bdg-order">発注待ち<b>${orderWait}</b></div>
          <div class="bdg" id="bdg-price">単価待ち<b>${priceWait}</b></div>
          <div class="bdg" id="bdg-review">判断待ち<b>—</b></div>
        </div>
        <div class="scroll home-scroll">
          ${mine.length ? STATUSES.map(section).join('') : `
            <div class="empty"><div class="big">見積はまだありません</div>下の「＋あたらしい見積」から作りましょう</div>`}
          <div class="pad-end"></div>
        </div>
        <div class="bottom-action">
          <button class="btn btn-primary btn-block btn-big" id="new-estimate">${icons.plus}あたらしい見積</button>
        </div>
      </div>`;

    container.querySelector('#bdg-order').addEventListener('click', openOrderWaitPage);
    container.querySelector('#bdg-price').addEventListener('click', openPendingPricePage);
    container.querySelector('#bdg-review').addEventListener('click', openReviewsPage);
    container.querySelectorAll('[data-scope]').forEach((el) => el.addEventListener('click', () => {
      local.set('homeScope', el.dataset.scope === 'all' ? 'all' : 'mine');
      renderHome(container, opts);
    }));
    container.querySelectorAll('[data-est]').forEach((el) => el.addEventListener('click', () => {
      location.hash = '#est/' + el.dataset.est;
    }));
    container.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async (ev) => {
      ev.stopPropagation();   // カードを開かない
      await confirmDeleteEstimate(cache.estimates.find((x) => x.id === b.dataset.del));
    }));
    container.querySelector('#new-estimate').addEventListener('click', async () => {
      try {
        const id = await createEstimate(local.get('staff', ''));
        sessionStorage.setItem('openCover', id); // 新規はまず表紙を開く
        location.hash = '#est/' + id;
      } catch (e) { console.error(e); toast('作成できませんでした'); }
    });
  }

  paint();
}

// 見積タブ: 自分の下書き・全状態の一覧（さがすの簡易版）
export function renderEstimatesTab(container) {
  const staffName = local.get('staff', '');
  const mine = cache.estimates.filter((e) => e.staff === staffName);
  container.innerHTML = `
    <div class="screen"><div class="scroll est-list-scroll">
      <div class="sec-head"><span class="ttl">自分の見積</span><span class="cnt">${mine.length}</span><span class="rule"></span></div>
      ${mine.length ? mine.map((e) => `
        <div class="card" data-est="${e.id}" style="cursor:pointer">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <div class="ttl" style="font-size:15px">${esc(e.projectName || '（工事名なし）')}</div>
            <span style="font-size:11.5px;color:var(--muted2)">${esc(e.status || '')}</span>
          </div>
          <div class="meta num">${e.orderNo ? '注番 ' + esc(e.orderNo) : ''}　<span style="color:var(--navy);font-weight:700">${YEN(e.totalFinal || 0)}</span></div>
        </div>`).join('') : '<div class="empty">まだありません</div>'}
    </div></div>`;
  container.querySelectorAll('[data-est]').forEach((el) => el.addEventListener('click', () => {
    location.hash = '#est/' + el.dataset.est;
  }));
}
