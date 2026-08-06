// ============================================================
// ホーム — 自分の工事／会社全体。状態3分類のカード
//
// 【概算もここに出す】現場の人が最初に開くのはホーム。
// 見積タブまで行かないと概算が無い状態だと、概算は使われない。
// だから一覧の一番上に「概算」を置き、下のボタンも概算を主にしている。
// ============================================================

import { esc, YEN, fmtDateJa, local } from './util.js?v=33';
import { icons } from './icons.js?v=33';
import { toast } from './ui.js?v=33';
import { cache, createEstimate } from './store.js?v=33';
import { createRough } from './rough-store.js?v=33';
import { isEmptyQuote } from './screen-handover.js?v=33';
import { openOrderWaitPage, confirmDeleteEstimate } from './screen-order.js?v=33';
import { openPendingPricePage, openReviewsPage } from './screen-settings.js?v=33';

const STATUSES = ['見積中', '発注待ち', '進行中'];

// 概算の札。見積タブの一覧と同じ色・同じ言葉にしてある
const KIND_BADGE = 'height:22px;padding:0 8px;background:var(--navy);border-radius:4px;color:#fff;'
  + 'font-size:11.5px;font-weight:700;display:inline-flex;align-items:center;flex:none';

// 中身が空の概算は出さない（見積タブの buildRows と同じ判定）
function liveRoughs() {
  return (cache.roughs || []).filter((r) =>
    r.status !== '完工' && !(isEmptyQuote(r) && !(r.photos || []).length && !r.oneLiner));
}

export function renderHome(container, opts = {}) {
  const scopeAll = local.get('homeScope', 'mine') === 'all';

  function paint() {
    const staffName = local.get('staff', '');
    const all = cache.estimates;
    const mine = scopeAll ? all : all.filter((e) => e.staff === staffName);
    const allRoughs = liveRoughs();
    const roughs = scopeAll ? allRoughs : allRoughs.filter((r) => r.staff === staffName);
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

    // 概算のカード。押すと写真から見積の画面（#rough/{id}）へ入る
    const roughCard = (r) => `
      <div class="card" data-rough="${r.id}" style="cursor:pointer">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="${KIND_BADGE}">概算</span>
          ${r.convertedEstimateId ? '<span style="font-size:11.5px;color:var(--muted2)">本見積あり</span>' : ''}
          <span style="margin-left:auto;font-size:11.5px;color:var(--muted2)" class="num">${fmtDateJa(r.updatedAt)}</span>
        </div>
        <div class="ttl" style="padding-top:8px">${esc(r.projectName || '（工事名なし）')}</div>
        ${r.customer ? `<div class="meta">${esc(r.customer)}</div>` : ''}
        <div style="display:flex;align-items:flex-end;justify-content:space-between;margin-top:8px">
          <span class="yen">${YEN(r.totalsFrozen?.withTax ?? r.totalFinal ?? 0)}</span>
          ${(r.pendingCount || 0) > 0 ? `<span class="tag-warn">${icons.clock}単価待ち ${r.pendingCount}</span>` : ''}
        </div>
        <div class="note">目安（税込）${r.itemsCount ? `／${r.itemsCount}項目` : '／項目はまだ'}</div>
      </div>`;

    const roughSection = () => (roughs.length ? `
      <div class="sec-head"><span class="ttl">概算</span><span class="cnt">${roughs.length}</span><span class="rule"></span></div>
      ${roughs.map(roughCard).join('')}` : '');

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
          ${roughs.length || mine.length ? roughSection() + STATUSES.map(section).join('') : `
            <div class="empty"><div class="big">見積はまだありません</div>
              写真を撮って値段の目安を出すなら「あたらしい概算」から</div>`}
          <div class="pad-end"></div>
        </div>
        <div class="bottom-action">
          <button class="btn btn-primary btn-block btn-big" id="new-rough">${icons.camera}あたらしい概算</button>
          <button class="btn btn-block" id="new-estimate" style="height:48px;margin-top:8px">${icons.plus}あたらしい本見積</button>
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
    container.querySelectorAll('[data-rough]').forEach((el) => el.addEventListener('click', () => {
      location.hash = '#rough/' + el.dataset.rough;
    }));
    container.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async (ev) => {
      ev.stopPropagation();   // カードを開かない
      await confirmDeleteEstimate(cache.estimates.find((x) => x.id === b.dataset.del));
    }));
    // 概算はここから。見積タブの「あたらしい概算」と同じ入口
    container.querySelector('#new-rough').addEventListener('click', async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true;
      try {
        const id = await createRough(local.get('staff', ''));
        sessionStorage.setItem('openRoughCover', id); // 新規はまず表紙を開く
        location.hash = '#rough/' + id;
      } catch (e) { console.error(e); toast('作れませんでした'); b.disabled = false; }
    });
    container.querySelector('#new-estimate').addEventListener('click', async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true;
      try {
        const id = await createEstimate(local.get('staff', ''));
        sessionStorage.setItem('openCover', id); // 新規はまず表紙を開く
        location.hash = '#est/' + id;
      } catch (e) { console.error(e); toast('作成できませんでした'); b.disabled = false; }
    });
  }

  paint();
}

// 見積タブは screen-handover.js の renderQuotesTab が持つ。
// 概算・本見積・完工を1本の流れで見せるため、ここにあった簡易版は畳んだ。
// PC で中央寄せする .est-list-scroll は renderQuotesTab 側に引き継いである。
