// ============================================================
// 項目のくわしい中身（画面2）
// 画面/AI概算見積_UI設計/項目のくわしい中身.dc.html のとおりに作る。
//
//   ざっくり … 人工の合計と、この項目にかかるもの（損料・法定福利費）
//   くわしく … 門型・玉掛け・トロリー等の段取りを行で出す。使わない行は外せる
//
// 【手順を出しても金額は変わらない】
//   モックの「出さなくても金額は同じです」を守る。
//   最初の1行は、いまの人数×時間をそのまま写して作る。
//   そこから足したぶんだけ増え、「使わない」を押したぶんだけ減る。
//
// 【芯5】押すところを増やさない。モックにあるものだけ置く。
//   ただし「この項目を消す」だけは足してある（項目カードの✕を全部やめた代わり。
//   1画面に1つ、いちばん下に、静かに置く）。
// ============================================================

import { esc, YEN, local } from './util.js?v=33';
import { icons } from './icons.js?v=33';
import { openOverlay, openNumpad, openTextInput, toast, confirmDialog } from './ui.js?v=33';
import {
  tradeRate, itemAmount, itemBreakdown, stepsManHours, stepAmount,
} from './rough-calc.js?v=33';
import { updateItem, deleteItem, setSteps, newStep } from './rough-store.js?v=33';
import { STEP_CHOICES } from './rough-templates.js?v=33';

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const NAVY_GRAD = 'linear-gradient(180deg,#24507A 0%,#1B3A5C 100%)';

// getState() → { rough, items, rates, unitRates }
export function openItemDetailPage(roughId, itemId, getState) {
  const ov = openOverlay();
  let mode = 'rough';          // 'rough' = ざっくり / 'detail' = くわしく
  let currentId = itemId;

  const state = () => {
    const s = getState();
    const list = (s.items || []).filter((i) => i.kind === '労務' || i.kind === '移動');
    const item = (s.items || []).find((i) => i.id === currentId);
    return { ...s, list, item, idx: list.findIndex((i) => i.id === currentId) };
  };

  function paint() {
    const s = state();
    if (!s.item) { ov.close(); return; }
    const it = s.item;
    const steps = it.steps || [];
    if (steps.length && mode === 'rough' && !paint.touched) mode = 'detail';
    paint.touched = true;

    const b = itemBreakdown(it, s.rates, s.unitRates);
    const rate = it.kind === '移動' ? s.unitRates.travelLabor : (num(it.rate) ?? tradeRate(s.unitRates, it.trade));

    ov.el.innerHTML = `
      <div class="screen" style="background:#EEF0F3">
        <div style="background:${NAVY_GRAD};flex:none;
          padding:calc(8px + env(safe-area-inset-top, 0px)) 12px 0 8px">
          <div style="display:flex;align-items:center;gap:10px">
            <button id="d-back" style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;
              color:#fff;background:none;border:0;font-size:24px;flex:none;cursor:pointer">‹</button>
            <div style="flex:1;min-width:0">
              <div style="color:#fff;font-size:19px;font-weight:700;line-height:1.2">${esc(it.name || '（名前なし）')}</div>
              <div style="color:rgba(255,255,255,0.72);font-size:11.5px;margin-top:3px;white-space:nowrap;
                overflow:hidden;text-overflow:ellipsis">${esc(s.rough.projectName || '')}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;padding:10px 4px 10px">
            ${['rough', 'detail'].map((m) => `
              <div data-mode="${m}" style="flex:1;display:flex;align-items:center;justify-content:center;height:44px;
                border-radius:6px;font-size:15px;cursor:pointer;
                ${mode === m ? 'background:#fff;color:#1B3A5C;font-weight:700'
                  : 'border:1px solid rgba(255,255,255,0.35);color:rgba(255,255,255,0.85);font-weight:500'}"
                >${m === 'rough' ? 'ざっくり' : 'くわしく'}</div>`).join('')}
          </div>
        </div>

        <div class="scroll est-list-scroll" style="padding:12px">
          ${mode === 'rough' ? roughBody(it, s, rate, steps) : detailBody(it, s, steps)}
        </div>

        <div style="flex:none;background:#1B3A5C;padding:12px 14px calc(14px + env(safe-area-inset-bottom, 0px))">
          <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:10px">
            <div>
              <div style="font-size:11.5px;color:rgba(255,255,255,0.68)">この項目（税抜）</div>
              <div style="font-family:var(--mono);font-size:28px;font-weight:700;color:#fff;letter-spacing:-.01em;
                padding-top:2px">${YEN(b.taxable)}</div>
            </div>
            <div style="font-size:11.5px;color:rgba(255,255,255,0.68);padding-bottom:4px">
              ${s.list.length}件のうち ${s.idx + 1}件目</div>
          </div>
          <div style="display:flex;gap:8px;padding-top:10px">
            <button id="d-prev" ${s.idx <= 0 ? 'disabled' : ''} style="flex:1;height:48px;border-radius:6px;
              font-family:var(--font);font-size:16px;font-weight:700;
              ${s.idx <= 0
                ? 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.45);cursor:not-allowed'
                : 'background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.4);color:#fff;cursor:pointer'}"
              >前の項目</button>
            <button id="d-ok" style="flex:1.4;height:48px;background:#fff;border:0;border-radius:6px;color:#1B3A5C;
              font-family:var(--font);font-size:16px;font-weight:700;display:flex;align-items:center;
              justify-content:center;gap:6px;cursor:pointer">
              <span style="font-size:18px;display:grid;place-items:center">${icons.check}</span>これでOK</button>
          </div>
        </div>
      </div>`;

    bind(s, steps);
  }

  // ---------- ざっくり ----------
  function roughBody(it, s, rate, steps) {
    const step = it.kind === '移動' ? 1 : 8;
    const amt = itemAmount(it, s.rates, s.unitRates) || 0;
    const b = itemBreakdown(it, s.rates, s.unitRates);
    const row = (l, v) => `
      <div style="display:flex;align-items:center;justify-content:space-between;height:36px;font-size:13.5px;color:#4A5A6B">
        <span>${l}</span><span style="font-family:var(--mono);font-weight:600;color:#16202B">${YEN(v)}</span></div>`;

    return `
      <div style="background:#fff;border:1px solid #D9DEE4;border-radius:6px;padding:14px">
        <div style="font-size:16px;font-weight:700;color:#16202B;line-height:1.4">${esc(it.name || '')}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:10px">
          <div style="font-size:13px;color:#4A5A6B">${esc(it.kind === '移動' ? '移動労務' : (it.trade || ''))}
            <b data-np style="font-family:var(--mono);font-weight:700;color:#16202B;cursor:pointer">${it.persons ?? 0}</b>人 ×
            <b data-nh style="font-family:var(--mono);font-weight:700;color:#16202B;cursor:pointer">${it.hours ?? 0}</b>h</div>
          <div style="display:flex;gap:6px;flex:none">
            <button data-d="-${step}" style="width:56px;height:44px;background:#fff;border:1px solid #C3CBD4;border-radius:6px;
              color:#1B3A5C;font-family:var(--mono);font-size:15px;font-weight:700;cursor:pointer">−${step}h</button>
            <button data-d="${step}" style="width:56px;height:44px;background:#fff;border:1px solid #C3CBD4;border-radius:6px;
              color:#1B3A5C;font-family:var(--mono);font-size:15px;font-weight:700;cursor:pointer">＋${step}h</button>
          </div>
        </div>
        <div style="text-align:right;padding-top:8px">
          <span style="font-family:var(--mono);font-size:26px;font-weight:700;color:#1B3A5C;letter-spacing:-.01em">${YEN(amt)}</span></div>
      </div>

      ${it.kind === '労務' ? `
        <button id="d-expand" style="width:100%;background:#fff;border:1px solid #D9DEE4;border-radius:6px;
          display:flex;align-items:center;gap:10px;padding:14px;margin-top:10px;cursor:pointer;font-family:var(--font)">
          <span style="font-size:18px;color:#1B3A5C;display:grid;place-items:center">${icons.listSearch}</span>
          <span style="flex:1;text-align:left;font-size:15px;font-weight:700;color:#16202B">
            ${steps.length ? `手順を見る（${steps.length}つ）` : '手順を出す'}</span>
          <span style="font-size:16px;color:#8A96A3;display:grid;place-items:center">${icons.caretDown}</span>
        </button>
        <div style="font-size:12px;color:#8A96A3;line-height:1.7;padding:8px 2px 0">
          門型・チェンブロック・トロリーなどの段取りは、押すと行になって出ます。<br>
          出さなくても金額は同じです。</div>` : ''}

      <div style="font-size:13px;font-weight:700;color:#1B3A5C;padding:18px 2px 8px">この項目にかかるもの</div>
      <div style="background:#fff;border:1px solid #D9DEE4;border-radius:6px;padding:4px 14px">
        ${row(`${it.kind === '移動' ? '移動労務' : '労務費'}（${esc(it.trade || '移動')} ${rate ? rate.toLocaleString('ja-JP') : '—'}円/h）`, b.amount)}
        ${b.depreciation ? row('損料 5%（吊具・工具）', b.depreciation) : ''}
        ${b.welfare ? row('法定福利費 16%（労務費のみ）', b.welfare) : ''}
      </div>

      <button id="d-del" style="width:100%;background:none;border:0;color:#b3261e;font-family:var(--font);
        font-size:14px;padding:22px 0 8px;cursor:pointer">この項目を消す</button>`;
  }

  // ---------- くわしく ----------
  function detailBody(it, s, steps) {
    if (!steps.length) {
      return `
        <div style="background:#fff;border:1px solid #D9DEE4;border-radius:6px;padding:24px 16px;text-align:center">
          <div style="font-size:14px;color:#6B7783;line-height:1.9">手順はまだ出していません。<br>
            「ざっくり」から<b style="color:#1B3A5C">手順を出す</b>を押してください。</div>
        </div>`;
    }
    const on = steps.filter((x) => x.enabled !== false);
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:0 2px 8px">
        <span style="font-size:13px;font-weight:700;color:#1B3A5C">手順</span>
        <span style="font-family:var(--mono);font-size:13px;font-weight:700;color:#7A8794">${steps.length}つ</span>
        <span style="flex:1;height:1px;background:#D2D8E0"></span>
        <span style="font-size:12px;color:#4A5A6B">合計 <b style="font-family:var(--mono)">${stepsManHours(steps)}h</b></span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${steps.map((st, i) => stepCard(st, i, s)).join('')}
      </div>
      <button id="d-addstep" style="width:100%;height:48px;background:#fff;border:1.5px dashed #A9B3BE;border-radius:6px;
        color:#1B3A5C;font-family:var(--font);font-size:14.5px;font-weight:700;display:flex;align-items:center;
        justify-content:center;gap:8px;margin-top:10px;cursor:pointer">
        <span style="font-size:18px;display:grid;place-items:center">${icons.plus}</span>手順を足す</button>
      <div style="font-size:12px;color:#8A96A3;line-height:1.7;padding:8px 2px 0">
        ${on.length}つを使っています。使わない手順は外せます。金額はそのぶん減ります。</div>`;
  }

  function stepCard(st, i, s) {
    const off = st.enabled === false;
    const amt = stepAmount(st, s.unitRates);
    return `
      <div style="background:#fff;border:1px solid #D9DEE4;border-radius:6px;padding:12px 14px;${off ? 'opacity:.55' : ''}">
        <div style="font-size:16px;font-weight:700;color:#16202B;line-height:1.4">
          <span style="font-family:var(--mono);font-size:12px;color:#8A96A3;margin-right:6px">${i + 1}</span>${esc(st.name || '')}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:8px">
          <div style="font-size:13px;color:#4A5A6B">${esc(st.trade || '')}
            <b data-sp="${i}" style="font-family:var(--mono);font-weight:700;color:#16202B;cursor:pointer">${st.persons ?? 0}</b>人 ×
            <b data-sh="${i}" style="font-family:var(--mono);font-weight:700;color:#16202B;cursor:pointer">${st.hours ?? 0}</b>h</div>
          <div style="display:flex;gap:6px;flex:none">
            <button data-sd="${i}" data-v="-2" style="width:52px;height:44px;background:#fff;border:1px solid #C3CBD4;
              border-radius:6px;color:#1B3A5C;font-family:var(--mono);font-size:15px;font-weight:700;cursor:pointer">−2h</button>
            <button data-sd="${i}" data-v="2" style="width:52px;height:44px;background:#fff;border:1px solid #C3CBD4;
              border-radius:6px;color:#1B3A5C;font-family:var(--mono);font-size:15px;font-weight:700;cursor:pointer">＋2h</button>
          </div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding-top:8px">
          <button data-soff="${i}" style="height:36px;padding:0 12px;background:#fff;border:1px solid #C3CBD4;
            border-radius:6px;color:${off ? '#1B3A5C' : '#6B7783'};font-family:var(--font);font-size:13px;
            font-weight:${off ? 700 : 400};cursor:pointer">${off ? '使う' : '使わない'}</button>
          <span style="font-family:var(--mono);font-size:22px;font-weight:700;letter-spacing:-.01em;
            color:${off ? '#A9B3BE' : '#1B3A5C'}">${off ? '￥—' : YEN(amt)}</span>
        </div>
      </div>`;
  }

  // ---------- 操作 ----------
  function bind(s, steps) {
    const q = (x) => ov.el.querySelector(x);
    const all = (x) => ov.el.querySelectorAll(x);
    const it = s.item;
    const save = (patch) => updateItem(roughId, it.id, patch).catch(() => toast('保存できませんでした'));
    const saveSteps = (list) => setSteps(roughId, it.id, list).catch(() => toast('保存できませんでした'));

    q('#d-back').addEventListener('click', ov.close);
    all('[data-mode]').forEach((el) => el.addEventListener('click', () => { mode = el.dataset.mode; paint(); }));

    q('#d-prev').addEventListener('click', () => {
      if (s.idx > 0) { currentId = s.list[s.idx - 1].id; paint.touched = false; paint(); }
    });
    q('#d-ok').addEventListener('click', () => {
      if (s.idx < s.list.length - 1) { currentId = s.list[s.idx + 1].id; paint.touched = false; paint(); }
      else ov.close();
    });

    // ざっくり
    all('[data-d]').forEach((el) => el.addEventListener('click', () => {
      save({ hours: Math.max(0, (num(it.hours) || 0) + Number(el.dataset.d)) });
    }));
    const np = q('[data-np]'); if (np) np.addEventListener('click', () => askNum(it, 'persons', '人数', '人'));
    const nh = q('[data-nh]'); if (nh) nh.addEventListener('click', () => askNum(it, 'hours', '時間', 'h'));

    const ex = q('#d-expand');
    if (ex) ex.addEventListener('click', async () => {
      if (!steps.length) {
        // 【出しても金額は変わらない】いまの人数×時間をそのまま1行目にする
        await saveSteps([newStep({
          name: it.name || '作業', trade: it.trade, persons: it.persons, hours: it.hours, source: 'human',
        })]);
        toast('いまの人工を1行目にしました。ここから足せます');
      }
      mode = 'detail'; paint();
    });

    const del = q('#d-del');
    if (del) del.addEventListener('click', async () => {
      if (!(await confirmDialog(`「${it.name || 'この項目'}」を消しますか?`, '消す'))) return;
      try {
        await deleteItem(roughId, it.id);
        toast('消しました');
        const rest = s.list.filter((x) => x.id !== it.id);
        if (rest.length) { currentId = rest[Math.min(s.idx, rest.length - 1)].id; paint.touched = false; paint(); }
        else ov.close();
      } catch (e) { console.error(e); toast('消せませんでした'); }
    });

    // くわしく
    all('[data-sd]').forEach((el) => el.addEventListener('click', () => {
      const i = +el.dataset.sd;
      const list = steps.map((x, j) => (j === i ? { ...x, hours: Math.max(0, (num(x.hours) || 0) + Number(el.dataset.v)) } : x));
      saveSteps(list);
    }));
    all('[data-sp]').forEach((el) => el.addEventListener('click', () => askStep(+el.dataset.sp, 'persons', '人数', '人')));
    all('[data-sh]').forEach((el) => el.addEventListener('click', () => askStep(+el.dataset.sh, 'hours', '時間', 'h')));
    all('[data-soff]').forEach((el) => el.addEventListener('click', () => {
      const i = +el.dataset.soff;
      saveSteps(steps.map((x, j) => (j === i ? { ...x, enabled: x.enabled === false } : x)));
    }));

    const add = q('#d-addstep');
    if (add) add.addEventListener('click', () => openStepChooser(steps, saveSteps));

    function askNum(item, field, title, unit) {
      openNumpad({
        title, value: item[field] ?? '', unit, allowDecimal: field !== 'persons',
        onDone: (n) => { if (n != null) save({ [field]: n }); },
      });
    }
    function askStep(i, field, title, unit) {
      openNumpad({
        title, value: steps[i]?.[field] ?? '', unit, allowDecimal: field !== 'persons',
        onDone: (n) => { if (n == null) return; saveSteps(steps.map((x, j) => (j === i ? { ...x, [field]: n } : x))); },
      });
    }
  }

  paint();

  // 裏で項目や手順が変わったら描き直す。
  // Firestoreの購読は写真から見積の画面が持っているので、あちらから呼んでもらう。
  return { refresh: () => { if (ov.el.isConnected) paint(); }, close: ov.close };
}

// ============================================================
// 手順を足す — 打たずにボタンで選ぶ
// ============================================================
function openStepChooser(steps, saveSteps) {
  const ov = openOverlay();
  ov.el.innerHTML = `
    <div class="screen" style="background:#EEF0F3">
      <div style="background:${NAVY_GRAD};flex:none;display:flex;align-items:center;gap:10px;
        padding:calc(8px + env(safe-area-inset-top, 0px)) 12px 10px 8px">
        <button id="s-x" style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;
          color:#fff;background:none;border:0;font-size:24px;flex:none;cursor:pointer">‹</button>
        <div style="color:#fff;font-size:19px;font-weight:700">手順を足す</div>
      </div>
      <div class="scroll est-list-scroll" style="padding:12px">
        <div style="display:flex;align-items:center;gap:8px;padding:0 2px 10px">
          <span style="font-size:13px;font-weight:700;color:#1B3A5C">よく使う段取りから選ぶ</span>
          <span style="flex:1;height:1px;background:#D2D8E0"></span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${STEP_CHOICES.map((c, i) => `
            <button data-c="${i}" style="width:100%;background:#fff;border:1px solid #D9DEE4;border-radius:6px;
              padding:14px;display:flex;align-items:center;gap:10px;cursor:pointer;font-family:var(--font)">
              <span style="flex:1;text-align:left;font-size:16px;font-weight:700;color:#16202B">${esc(c.name)}</span>
              <span style="font-size:12.5px;color:#8A96A3;flex:none">${esc(c.trade)} ${c.persons}人×${c.hours}h</span>
            </button>`).join('')}
        </div>
        <div style="font-size:12px;color:#8A96A3;padding:10px 2px 0;line-height:1.7">
          押すと手順の行になります。時間は行で直せます。</div>
        <button id="s-say" style="width:100%;height:52px;background:#fff;border:1.5px dashed #A9B3BE;border-radius:6px;
          color:#1B3A5C;font-family:var(--font);font-size:15px;font-weight:700;display:flex;align-items:center;
          justify-content:center;gap:8px;margin-top:14px;cursor:pointer">
          <span style="font-size:19px;display:grid;place-items:center">${icons.pencil}</span>ここに無いものを入れる</button>
      </div>
    </div>`;

  ov.el.querySelector('#s-x').addEventListener('click', ov.close);
  ov.el.querySelectorAll('[data-c]').forEach((el) => el.addEventListener('click', async () => {
    const c = STEP_CHOICES[+el.dataset.c];
    await saveSteps([...steps, newStep({ ...c, source: 'human' })]);
    ov.close();
    toast(`「${c.name}」を足しました`);
  }));
  ov.el.querySelector('#s-say').addEventListener('click', () => {
    openTextInput({
      title: '手順の名前', placeholder: '例）足場の組立',
      hint: 'キーボードのマイクを押すと、声でも入れられます。',
      onDone: async (name) => {
        if (!name) return;
        await saveSteps([...steps, newStep({ name, trade: '現場工事', persons: 2, hours: 2, source: 'human' })]);
        ov.close();
        toast(`「${name}」を足しました`);
      },
    });
  });
}
