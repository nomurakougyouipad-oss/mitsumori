// ============================================================
// 設定とマスター（画面5）＋ 事務所の作業
// 要対応（単価待ち・判断待ち）／率の設定（実例つき・履歴）／時間単価
// 単価マスター・取引先・仕入先・常設注番／集計表読み込み／書き戻しCSV
// ============================================================

import { esc, YEN, fmtDate, downloadCsv, local } from './util.js?v=2';
import { openOverlay, openNumpad, toast, confirmDialog } from './ui.js?v=2';
import { cache, searchItems, isStale, updateEstimate, saveSummary, addNamed } from './store.js?v=2';
import { totals } from './calc.js?v=2';
import {
  db, doc, collection, addDoc, updateDoc, deleteDoc, getDocs, setDoc,
  onSnapshot, query, orderBy, serverTimestamp, Timestamp,
} from './firebase.js?v=2';
import { openTallyPage } from './screen-tally.js?v=2';
import { recordRateChange, tradeKey } from './rate-history.js?v=2';
import { openActualsListPage, openActualEditPage } from './screen-handover.js?v=2';

const RATE_DEFS = [
  ['material', '材料費 上乗せ%', '原価に対して'],
  ['labor', '労務費 上乗せ%', '原価に対して'],
  ['overhead', '諸経費%', '材料費＋労務費'],
  ['welfare', '法定福利費%', '労務費'],
  ['depreciation', '損料%', '材料費＋労務費'],
  ['tax', '消費税%', ''],
  ['targetMargin', '売上目標%', '参考表示のみ・計算に入れない'],
];
const pctN = (v) => Math.round((v || 0) * 1000) / 10;

export function renderSettingsTab(container) {
  const pendingEsts = cache.estimates.filter((e) => (e.pendingCount || 0) > 0);
  const staffName = local.get('staff', '');
  container.innerHTML = `
    <div class="screen"><div class="scroll">
      <div class="sec-head"><span class="ttl">要対応</span><span class="rule"></span></div>
      <div class="card" id="st-pending" style="cursor:pointer">
        <div class="ttl" style="font-size:14px">単価待ちの品目 <b class="num" style="color:${pendingEsts.length ? 'var(--accent)' : 'inherit'}">${pendingEsts.reduce((a, e) => a + e.pendingCount, 0)}</b> 件</div>
        <div class="meta">現場が名前だけ入れたもの。業者に聞いて金額を入れる</div></div>
      <div class="card" id="st-reviews" style="cursor:pointer">
        <div class="ttl" style="font-size:14px">単価の判断待ち <b class="num" id="st-rvcount">…</b> 件</div>
        <div class="meta">集計表と単価マスターの差。承認か据え置きを決める</div></div>
      <div class="sec-head"><span class="ttl">率と単価</span><span class="rule"></span></div>
      <div class="card" id="st-rates" style="cursor:pointer"><div class="ttl" style="font-size:14px">率の設定</div>
        <div class="meta">${RATE_DEFS.slice(0, 5).map(([k]) => pctN(cache.rates[k]) + '%').join('・')} …</div></div>
      <div class="card" id="st-units" style="cursor:pointer"><div class="ttl" style="font-size:14px">時間単価</div>
        <div class="meta">職種${(cache.unitRates.trades || []).length}つ・車両${cache.unitRates.kmRate}円/km・移動労務${cache.unitRates.travelLabor}円/h</div></div>
      <div class="sec-head"><span class="ttl">マスター</span><span class="rule"></span></div>
      <div class="card" id="st-items" style="cursor:pointer"><div class="ttl" style="font-size:14px">単価マスター ${cache.items.length}件</div>
        <div class="meta">検索・編集・古い単価に色・別名</div></div>
      <div class="card" id="st-customers" style="cursor:pointer"><div class="ttl" style="font-size:14px">取引先 ${cache.customers.length}件</div>
        <div class="meta">法定福利費なしフラグ</div></div>
      <div class="card" id="st-suppliers" style="cursor:pointer"><div class="ttl" style="font-size:14px">仕入先 ${cache.suppliers.length}件</div>
        <div class="meta">発注統合名・単価変動ありフラグ</div></div>
      <div class="card" id="st-standing" style="cursor:pointer"><div class="ttl" style="font-size:14px">常設注番 ${cache.standingOrders.length}件</div>
        <div class="meta">工場・区分ごとの受け皿</div></div>
      <div class="sec-head"><span class="ttl">実績</span><span class="rule"></span></div>
      <div class="card" id="st-actuals" style="cursor:pointer"><div class="ttl" style="font-size:14px">完工した工事 ${cache.actuals.length}件</div>
        <div class="meta">${cache.actuals.length < 3
          ? 'あと' + (3 - cache.actuals.length) + '件たまると、相場ではなく「よつばの金額」で概算が出せます'
          : '工事の種類ごとの実額。次の概算のもとになる'}</div></div>
      <div class="card" id="st-actual-add" style="cursor:pointer"><div class="ttl" style="font-size:14px">過去の工事を入れる</div>
        <div class="meta">見積が無い分。工事の種類／何人で何日／材料／請求額 の4つだけ</div></div>
      <div class="sec-head"><span class="ttl">集計表とExcel</span><span class="rule"></span></div>
      <div class="card" id="st-tally" style="cursor:pointer"><div class="ttl" style="font-size:14px">集計表を読み込む</div>
        <div class="meta">事務員さんの「納品書 材料集計表」から単価マスターを育てる</div></div>
      <div class="card" id="st-export" style="cursor:pointer"><div class="ttl" style="font-size:14px">単価マスターをCSVへ書き出す</div>
        <div class="meta">月1回、ExcelのA〜K列に書き戻す用（シート全体の貼り替えはNG）</div></div>
      <div class="sec-head"><span class="ttl">その他</span><span class="rule"></span></div>
      <div class="card" id="st-staff" style="cursor:pointer"><div class="ttl" style="font-size:14px">担当者：${esc(staffName || '未選択')}</div>
        <div class="meta">タップして切り替える</div></div>
      <div class="card" id="st-check" style="cursor:pointer"><div class="ttl" style="font-size:14px">接続テスト</div></div>
      <div style="height:16px"></div>
    </div></div>`;

  getDocs(query(collection(db, 'priceReviews'))).then((s) => {
    const n = s.docs.filter((d) => d.data().status === '判断待ち').length;
    const el = container.querySelector('#st-rvcount');
    if (el) { el.textContent = n; if (n) el.style.color = 'var(--accent)'; }
  }).catch(() => {});

  container.querySelector('#st-pending').addEventListener('click', openPendingPricePage);
  container.querySelector('#st-reviews').addEventListener('click', openReviewsPage);
  container.querySelector('#st-rates').addEventListener('click', openRatesPage);
  container.querySelector('#st-units').addEventListener('click', openUnitRatesPage);
  container.querySelector('#st-items').addEventListener('click', openItemsPage);
  container.querySelector('#st-customers').addEventListener('click', () => openNamedMaster('customers', '取引先', [['email', 'メール'], ['noWelfare', '法定福利費なし', 'bool']]));
  container.querySelector('#st-suppliers').addEventListener('click', () => openNamedMaster('suppliers', '仕入先', [['email', 'メール'], ['mergeName', '発注統合名'], ['priceVolatile', '単価変動あり', 'bool']]));
  container.querySelector('#st-standing').addEventListener('click', () => openNamedMaster('standingOrders', '常設注番', [['orderNo', '注番'], ['staff', '担当者']]));
  container.querySelector('#st-actuals').addEventListener('click', openActualsListPage);
  container.querySelector('#st-actual-add').addEventListener('click', () => openActualEditPage(null));
  container.querySelector('#st-tally').addEventListener('click', openTallyPage);
  container.querySelector('#st-export').addEventListener('click', exportItemsCsv);
  container.querySelector('#st-staff').addEventListener('click', () => document.dispatchEvent(new Event('open-staff-modal')));
  container.querySelector('#st-check').addEventListener('click', () => { location.href = './tools/setup-check.html'; });
}

// ---------- 率の設定（実例プレビュー・入力ガード・履歴） ----------
function openRatesPage() {
  const ov = openOverlay();
  let history = [];
  function paint() {
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar"><button class="icon-btn" id="r-back">←</button><span class="ttl">率の設定（会社で1つ）</span></div></div>
      <div class="page-body"><div class="form-page">
        ${RATE_DEFS.map(([k, lbl, note]) => `
          <div class="rate-row"><span class="lb">${lbl}<br><small style="color:var(--muted2)">${note}</small></span>
            <div class="rate-input" data-rk="${k}"><b>${pctN(cache.rates[k])}</b><span>%</span></div></div>`).join('')}
        <div style="font-size:12px;color:var(--muted);margin-top:8px;line-height:1.7" id="r-example">
          実例：材料費${pctN(cache.rates.material)}% → 原価10,000円の材料が <b class="num">${YEN(Math.round(10000 * (1 + cache.rates.material)))}</b> で計上されます</div>
        <div class="sec-head" style="margin-top:16px"><span class="ttl">変更履歴</span><span class="rule"></span></div>
        <div id="r-hist" style="font-size:12.5px;color:var(--muted);line-height:2">
          ${history.length ? history.map((h) => `${fmtDate(h.at)}　${esc(h.staff || '—')}　${esc(h.label || h.key)}: ${h.from}% → ${h.to}%`).join('<br>') : '（まだありません）'}</div>
      </div></div>`;
    ov.el.querySelector('#r-back').addEventListener('click', ov.close);
    ov.el.querySelectorAll('[data-rk]').forEach((el) => el.addEventListener('click', () => {
      const k = el.dataset.rk;
      const def = RATE_DEFS.find((d) => d[0] === k);
      openNumpad({
        title: def[1], value: pctN(cache.rates[k]), unit: '%',
        onDone: async (n) => {
          if (n == null) return;
          if (n >= 100) { toast('100%以上は入れられません'); return; }
          if (n >= 1 && n < 2 && !(await confirmDialog(`${n}% で合っていますか?（${Math.round(n * 100)}%の間違いではありませんか?）`, 'この値でよい'))) return;
          const from = pctN(cache.rates[k]);
          try {
            await setDoc(doc(db, 'settings', 'rates'), { ...cache.rates, [k]: n / 100 });
            await recordRateChange({
              scope: 'standard', key: k, label: def[1], unit: '%',
              from, to: n, staff: local.get('staff', ''),
            });
            toast(`${def[1]}を ${from}% → ${n}% に変えました（今後の見積から反映）`);
            setTimeout(load, 400);
          } catch (e) { console.error(e); toast('保存できませんでした'); }
        },
      });
    }));
  }
  async function load() {
    try {
      const s = await getDocs(query(collection(db, 'settings', 'rates', 'history'), orderBy('at', 'desc')));
      history = s.docs.slice(0, 20).map((d) => d.data());
    } catch (_) {}
    paint();
  }
  load();
}

// ---------- 時間単価 ----------
function openUnitRatesPage() {
  const ov = openOverlay();
  function paint() {
    const u = cache.unitRates;
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar"><button class="icon-btn" id="u-back">←</button><span class="ttl">時間単価</span></div></div>
      <div class="page-body"><div class="form-page">
        ${(u.trades || []).map((t, i) => `
          <div class="rate-row"><span class="lb">${esc(t.name)}</span>
            <div class="rate-input" data-ti="${i}"><b>${t.rate.toLocaleString('ja-JP')}</b><span>円/h</span></div></div>`).join('')}
        <div class="rate-row"><span class="lb">車両移動</span>
          <div class="rate-input" data-uk="kmRate"><b>${u.kmRate}</b><span>円/km</span></div></div>
        <div class="rate-row"><span class="lb">移動労務費</span>
          <div class="rate-input" data-uk="travelLabor"><b>${u.travelLabor.toLocaleString('ja-JP')}</b><span>円/h</span></div></div>
      </div></div>`;
    ov.el.querySelector('#u-back').addEventListener('click', ov.close);
    const save = async (patch) => {
      try { await setDoc(doc(db, 'settings', 'unitRates'), { trades: cache.unitRates.trades, travelLabor: cache.unitRates.travelLabor, kmRate: cache.unitRates.kmRate, ...patch }); setTimeout(paint, 400); }
      catch (e) { console.error(e); toast('保存できませんでした'); }
    };
    ov.el.querySelectorAll('[data-ti]').forEach((el) => el.addEventListener('click', () => {
      const i = +el.dataset.ti;
      openNumpad({ title: u.trades[i].name, value: u.trades[i].rate, unit: '円/h', allowDecimal: false, onDone: async (n) => {
        if (n == null) return;
        const from = u.trades[i].rate;
        const trades = u.trades.map((t, j) => j === i ? { ...t, rate: n } : t);
        await save({ trades });
        // 職種の単価も履歴に残す（誰が・いつ・何を・いくらから いくらに）
        try {
          await recordRateChange({
            scope: 'standard', key: tradeKey(u.trades[i].name), label: u.trades[i].name,
            unit: '円/h', from, to: n, staff: local.get('staff', ''),
          });
        } catch (e) { console.warn('履歴を残せませんでした:', e); }
      } });
    }));
    ov.el.querySelectorAll('[data-uk]').forEach((el) => el.addEventListener('click', () => {
      const k = el.dataset.uk;
      openNumpad({ title: k === 'kmRate' ? '車両移動' : '移動労務費', value: u[k], unit: '円', allowDecimal: false, onDone: (n) => { if (n != null) save({ [k]: n }); } });
    }));
  }
  paint();
}

// ---------- 単価マスター（検索・編集・削除ガード） ----------
function openItemsPage() {
  const ov = openOverlay();
  let q = '';
  function paint() {
    const hits = searchItems(q, 30);
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar"><button class="icon-btn" id="i-back">←</button><span class="ttl">単価マスター ${cache.items.length}件</span></div></div>
      <div class="search-block"><div class="search-box" style="height:48px">
        <input id="i-q" placeholder="品名・仕入先・材質で検索" value="${esc(q)}" style="font-size:16px" autocomplete="off"></div></div>
      <div class="page-body">
        ${hits.map((it) => `
          <div class="cand" data-id="${it.id}" style="padding-left:14px">
            <div style="display:flex;align-items:center">
              <div style="flex:1;min-width:0">
                <div class="nm">${esc(it.name)}</div>
                <div class="sub">${esc(it.supplier || '—')} ／ <b>${it.cost != null ? YEN(it.cost) : '—'}</b>／${esc(it.unit || '')} ／ 更新 ${it.updatedAt ? fmtDate(it.updatedAt) : esc(it.updatedAtRaw || '不明')}${(it.aliases || []).length ? ' ／ 別名' + it.aliases.length : ''}</div>
              </div>
              ${isStale(it) ? '<span class="cand-badge stale">単価が古い</span>' : ''}
            </div>
          </div>`).join('')}
      </div>`;
    ov.el.querySelector('#i-back').addEventListener('click', ov.close);
    const input = ov.el.querySelector('#i-q');
    input.addEventListener('input', () => { q = input.value; paint(); const i2 = ov.el.querySelector('#i-q'); i2.focus(); i2.setSelectionRange(i2.value.length, i2.value.length); });
    ov.el.querySelectorAll('[data-id]').forEach((el) => el.addEventListener('click', () => editItem(cache.items.find((x) => x.id === el.dataset.id), paint)));
  }
  paint();
}

function editItem(it, onDone) {
  if (!it) return;
  const root = document.getElementById('modal-root');
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal"><div class="modal-head">品目を編集<button class="x" id="ie-x">×</button></div>
    <div class="modal-body">
      <div style="font-size:14px;font-weight:700">${esc(it.name)}</div>
      <div class="rate-row"><span class="lb">原価</span><div class="rate-input" id="ie-cost"><b>${it.cost != null ? it.cost.toLocaleString('ja-JP') : '—'}</b><span>円</span></div></div>
      ${it.kgPrice != null ? `<div class="rate-row"><span class="lb">kg単価（原価を自動再計算）</span><div class="rate-input" id="ie-kg"><b>${it.kgPrice}</b><span>円/kg</span></div></div>` : ''}
      ${(it.aliases || []).length ? `<div style="font-size:12px;color:var(--muted)">別名: ${it.aliases.map(esc).join(' ／ ')}</div>` : ''}
      <button class="btn btn-danger btn-block" id="ie-del">この品目を削除</button>
    </div></div>`;
  root.appendChild(back);
  const close = () => back.remove();
  back.querySelector('#ie-x').addEventListener('click', close);
  back.querySelector('#ie-cost').addEventListener('click', () => openNumpad({
    title: '原価', value: it.cost ?? '', unit: '円', onDone: async (n) => {
      if (n == null) return;
      await updateDoc(doc(db, 'items', it.id), { cost: n, updatedAt: Timestamp.now() });
      toast('原価を更新しました'); close(); onDone();
    } }));
  back.querySelector('#ie-kg')?.addEventListener('click', () => openNumpad({
    title: 'kg単価', value: it.kgPrice ?? '', unit: '円/kg', onDone: async (n) => {
      if (n == null) return;
      const patch = { kgPrice: n, updatedAt: Timestamp.now() };
      if (it.weight != null) patch.cost = Math.round(it.weight * n);
      await updateDoc(doc(db, 'items', it.id), patch);
      toast('kg単価を更新しました' + (patch.cost != null ? `（原価 ${YEN(patch.cost)}）` : '')); close(); onDone();
    } }));
  back.querySelector('#ie-del').addEventListener('click', async () => {
    if ((it.useCount || 0) > 0) { toast('見積で使用中のため削除できません'); return; }
    if (!(await confirmDialog(`「${it.name}」を削除しますか?`, '削除する'))) return;
    await deleteDoc(doc(db, 'items', it.id));
    toast('削除しました'); close(); onDone();
  });
}

// ---------- 汎用マスタ（取引先・仕入先・常設注番） ----------
function openNamedMaster(col, title, fields) {
  const ov = openOverlay();
  function paint() {
    const list = cache[col === 'standingOrders' ? 'standingOrders' : col] || [];
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar"><button class="icon-btn" id="n-back">←</button><span class="ttl">${title}マスター</span></div></div>
      <div class="page-body"><div style="padding:12px">
        ${list.map((m) => `
          <div class="card" style="margin-bottom:8px;cursor:pointer" data-id="${m.id}">
            <div class="ttl" style="font-size:14px">${esc(m.name)}${col === 'standingOrders' ? `　<span class="num" style="font-weight:500">${esc(m.orderNo || '')}</span>` : ''}</div>
            <div class="meta">${fields.map(([k, lbl, type]) => type === 'bool' ? (m[k] ? lbl : '') : (m[k] ? lbl + ': ' + esc(String(m[k])) : '')).filter(Boolean).join(' ／ ') || '—'}</div>
          </div>`).join('')}
        <button class="btn btn-block" id="n-add">＋ ${title}を追加</button>
      </div></div>`;
    ov.el.querySelector('#n-back').addEventListener('click', ov.close);
    ov.el.querySelector('#n-add').addEventListener('click', () => editNamed(col, title, fields, null, paint));
    ov.el.querySelectorAll('[data-id]').forEach((el) => el.addEventListener('click', () => {
      const m = (cache[col] || []).find((x) => x.id === el.dataset.id);
      editNamed(col, title, fields, m, paint);
    }));
  }
  paint();
}

function editNamed(col, title, fields, m, onDone) {
  const root = document.getElementById('modal-root');
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal"><div class="modal-head">${title}${m ? 'を編集' : 'を追加'}<button class="x" id="ne-x">×</button></div>
    <div class="modal-body">
      <div class="field"><label>名称</label><input class="input" id="ne-name" value="${esc(m?.name || '')}"></div>
      ${fields.map(([k, lbl, type]) => type === 'bool'
        ? `<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer"><input type="checkbox" id="ne-${k}" ${m?.[k] ? 'checked' : ''} style="width:18px;height:18px">${lbl}</label>`
        : `<div class="field"><label>${lbl}</label><input class="input" id="ne-${k}" value="${esc(m?.[k] || '')}"></div>`).join('')}
      <div style="display:flex;gap:8px">
        ${m ? '<button class="btn btn-danger" id="ne-del" style="flex:1">削除</button>' : ''}
        <button class="btn btn-primary" id="ne-save" style="flex:2">保存</button>
      </div>
    </div></div>`;
  root.appendChild(back);
  const close = () => back.remove();
  back.querySelector('#ne-x').addEventListener('click', close);
  back.querySelector('#ne-save').addEventListener('click', async () => {
    const name = back.querySelector('#ne-name').value.trim();
    if (!name) { toast('名称を入れてください'); return; }
    const data = { name };
    for (const [k, , type] of fields) data[k] = type === 'bool' ? back.querySelector('#ne-' + k).checked : back.querySelector('#ne-' + k).value.trim();
    try {
      if (m) await updateDoc(doc(db, col, m.id), data);
      else await addNamed(col, data);
      toast('保存しました'); close(); setTimeout(onDone, 400);
    } catch (e) { console.error(e); toast('保存できませんでした'); }
  });
  back.querySelector('#ne-del')?.addEventListener('click', async () => {
    // 使用中は削除させないガード（見積の宛先・担当者に使われていないか）
    if (col === 'customers' && cache.estimates.some((e) => e.customer === m.name)) { toast('見積で使用中のため削除できません'); return; }
    if (col === 'standingOrders' && cache.estimates.some((e) => e.orderNo === m.orderNo)) { toast('見積で使用中のため削除できません'); return; }
    if (!(await confirmDialog(`「${m.name}」を削除しますか?`, '削除する'))) return;
    await deleteDoc(doc(db, col, m.id));
    toast('削除しました'); close(); setTimeout(onDone, 400);
  });
}

// ---------- 単価待ちに実単価を入れる（事務所） ----------
export function openPendingPricePage() {
  const ov = openOverlay();
  async function paint() {
    const ests = cache.estimates.filter((e) => (e.pendingCount || 0) > 0);
    const blocks = await Promise.all(ests.map(async (e) => {
      const snap = await getDocs(collection(db, 'estimates', e.id, 'lines'));
      const pend = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((l) => l.pendingPrice);
      return { est: e, lines: snap.docs.map((d) => ({ id: d.id, ...d.data() })), pend };
    }));
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar"><button class="icon-btn" id="p-back">←</button><span class="ttl">単価待ちの品目</span></div></div>
      <div class="page-body"><div style="padding:12px">
        ${blocks.filter((b) => b.pend.length).map((b) => `
          <div class="sec-head"><span class="ttl">${esc(b.est.projectName || '（工事名なし）')}</span><span class="cnt num">${esc(b.est.orderNo || '')}</span><span class="rule"></span></div>
          ${b.pend.map((l) => `
            <div class="card" style="margin-bottom:8px">
              <div class="ttl" style="font-size:14px">⏱ ${esc(l.name)}</div>
              <div class="meta">${l.fabSpec ? esc([l.fabSpec.material, l.fabSpec.thickness ? 't' + l.fabSpec.thickness : '', (l.fabSpec.works || []).join('・'), l.fabSpec.vendor ? '頼む先:' + l.fabSpec.vendor : ''].filter(Boolean).join(' ／ ')) : ''}　数量 ${l.qty}${esc(l.unit || '')}${l.tempCost ? `　仮 ${YEN(l.tempCost)}` : ''}</div>
              <button class="btn btn-sm" style="margin-top:8px" data-fill="${b.est.id}|${l.id}">実単価を入れる</button>
            </div>`).join('')}`).join('') || '<div class="empty">単価待ちはありません</div>'}
      </div></div>`;
    ov.el.querySelector('#p-back').addEventListener('click', ov.close);
    ov.el.querySelectorAll('[data-fill]').forEach((btn) => btn.addEventListener('click', () => {
      const [estId, lineId] = btn.dataset.fill.split('|');
      const b = blocks.find((x) => x.est.id === estId);
      const l = b.pend.find((x) => x.id === lineId);
      openNumpad({ title: '実単価（' + l.name.slice(0, 12) + '）', value: l.tempCost ?? '', unit: '円', onDone: async (n) => {
        if (n == null) return;
        try {
          await updateDoc(doc(db, 'estimates', estId, 'lines', lineId), { cost: n, pendingPrice: false, resolvedAt: serverTimestamp() });
          // サマリー再計算＋「単価が入りました」の印
          const snap = await getDocs(collection(db, 'estimates', estId, 'lines'));
          const lines = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          const rates = { ...cache.rates, ...(b.est.rates || {}) };
          const unit = { ...cache.unitRates, ...(b.est.unitRates || {}) };
          const t = totals(lines, rates, unit, b.est.welfareOn !== false, b.est.adjust || 0);
          await saveSummary(estId, t, lines);
          await updateEstimate(estId, { priceFilled: true });
          toast(l.tempCost ? `仮${YEN(l.tempCost)} → 実${YEN(n)} で確定しました` : '実単価を入れました');
          paint();
        } catch (e) { console.error(e); toast('保存できませんでした'); }
      } });
    }));
  }
  paint();
}

// ---------- 判断待ち（priceReviews） ----------
export function openReviewsPage() {
  const ov = openOverlay();
  async function paint() {
    const snap = await getDocs(query(collection(db, 'priceReviews'), orderBy('createdAt', 'desc')));
    const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const open = all.filter((r) => r.status === '判断待ち');
    const done = all.filter((r) => r.status !== '判断待ち').slice(0, 20);
    const row = (r, withBtns) => `
      <div class="card" style="margin-bottom:8px">
        <div class="ttl" style="font-size:14px">${esc(r.name || r.itemId || '')}</div>
        <div class="meta">${esc(r.reason || '')}　<b class="num">${r.currentCost != null ? YEN(r.currentCost) : '—'}</b> → <b class="num" style="color:var(--navy)">${r.newCost != null ? YEN(r.newCost) : '—'}</b>${r.unitKind ? '／' + esc(r.unitKind) : ''}　<span style="color:var(--muted2)">${esc(r.source || '')}</span></div>
        ${withBtns ? `<div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-sm" data-ok="${r.id}">承認（マスター更新）</button>
          <button class="btn btn-sm" data-keep="${r.id}">据え置き（記録だけ）</button></div>`
        : `<div class="meta">${esc(r.status)}　${r.decidedAt ? fmtDate(r.decidedAt) : ''}</div>`}
      </div>`;
    ov.el.innerHTML = `
      <div class="page-head"><div class="bar"><button class="icon-btn" id="rv-back">←</button><span class="ttl">単価の判断待ち ${open.length}件</span></div></div>
      <div class="page-body"><div style="padding:12px">
        ${open.map((r) => row(r, true)).join('') || '<div class="empty">判断待ちはありません</div>'}
        ${done.length ? `<div class="sec-head"><span class="ttl">決めたもの（据え置きも日付つきで残る）</span><span class="rule"></span></div>${done.map((r) => row(r, false)).join('')}` : ''}
      </div></div>`;
    ov.el.querySelector('#rv-back').addEventListener('click', ov.close);
    ov.el.querySelectorAll('[data-ok]').forEach((b) => b.addEventListener('click', async () => {
      const r = open.find((x) => x.id === b.dataset.ok);
      try {
        if (r.itemId) {
          const patch = { updatedAt: Timestamp.now() };
          if (r.unitKind === 'kg単価') {
            patch.kgPrice = r.newCost;
            const it = cache.items.find((x) => x.id === r.itemId);
            if (it && it.weight != null) patch.cost = Math.round(it.weight * r.newCost);
          } else patch.cost = r.newCost;
          await updateDoc(doc(db, 'items', r.itemId), patch);
        }
        await updateDoc(doc(db, 'priceReviews', r.id), { status: '承認', decidedAt: serverTimestamp() });
        toast('承認してマスターを更新しました'); paint();
      } catch (e) { console.error(e); toast('保存できませんでした'); }
    }));
    ov.el.querySelectorAll('[data-keep]').forEach((b) => b.addEventListener('click', async () => {
      await updateDoc(doc(db, 'priceReviews', b.dataset.keep), { status: '据え置き', decidedAt: serverTimestamp() });
      toast('据え置きで記録しました（次回また調べ直さないため）'); paint();
    }));
  }
  paint();
}

// ---------- 単価マスターの書き戻しCSV（A〜K列） ----------
function exportItemsCsv() {
  const rows = [['大分類', '仕入先', '品名・規格', '単位', '原価（円）', '更新日', '材質', '規格（元データ）', '重量(kg)', '㎏単価', '種類']];
  for (const it of cache.items) {
    rows.push([it.category || '', it.supplier || '', it.name || '', it.unit || '',
      it.cost ?? '', it.updatedAt ? fmtDate(it.updatedAt) : (it.updatedAtRaw || ''),
      it.material || '', it.spec || '', it.weight ?? '', it.kgPrice ?? '', it.type || '']);
  }
  const d = new Date();
  downloadCsv(`単価マスター_書き戻し_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`, rows);
  toast('CSVを書き出しました。ExcelはA〜K列のデータ行だけ差し替えてください（行削除は厳禁）');
}
