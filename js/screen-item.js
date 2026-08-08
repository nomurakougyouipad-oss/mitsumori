// ============================================================
// 項目のくわしい中身（画面2）
// 画面/AI概算見積_UI設計/項目のくわしい中身.dc.html のとおりに作る。
//
//   ざっくり … 工数（1工数＝8時間）と、この項目にかかるもの（損料・法定福利費）
//   くわしく … 門型・玉掛け・トロリー等の段取りを行で出す。使わない行は外せる
//
// 【手順を出しても金額は変わらない】
//   モックの「出さなくても金額は同じです」を守る。
//   最初の1行は、いまの人数×時間をそのまま写して作る。
//   そこから足したぶんだけ増え、「使わない」を押したぶんだけ減る。
//
// 【直すのはここだけ】2026/8/7
//   一覧は見るところ、ここは直すところ。分かれていないと迷う。
//   だから一覧から金額と人数×時間の直しを全部こちらへ移した。
//   ・費目に関係なく、どの項目からもここへ来られる（材料も外注も単価待ちも）
//   ・消せるのもここだけ。1画面に1つ、いちばん下に、静かに置く
//   一覧側に直すボタンを戻さないこと（screen-rough.js の itemCard）。
//
// 【芯5】押すところを増やさない。モックにあるものだけ置く。
// ============================================================

import { esc, YEN, local } from './util.js?v=33';
import { icons } from './icons.js?v=33';
import { openOverlay, openNumpad, openTextInput, toast, confirmDialog } from './ui.js?v=33';
import {
  tradeRate, itemAmount, itemBreakdown, stepsManHours, stepAmount,
  yotsubaAmount, marketAmount, materialCountText,
  HOURS_PER_KOSU, hoursToKosu, kosuToHours, kosuText,
} from './rough-calc.js?v=33';
import { piecesFor } from './rough-material.js?v=33';
import {
  updateItem, deleteItem, setSteps, newStep,
  decideItem, markPending, overrideItemAmount,
} from './rough-store.js?v=33';
import { STEP_CHOICES } from './rough-templates.js?v=33';

// 人数×時間で数える費目かどうか。それ以外は金額そのものを直す
const isTimeKind = (it) => it.kind === '労務' || it.kind === '移動';

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const NAVY_GRAD = 'linear-gradient(180deg,#24507A 0%,#1B3A5C 100%)';

// getState() → { rough, items, rates, unitRates }
export function openItemDetailPage(roughId, itemId, getState) {
  const ov = openOverlay();
  let mode = 'rough';          // 'rough' = ざっくり / 'detail' = くわしく
  let currentId = itemId;

  // 【全部の費目を並べる】前は労務と移動しか入れていなかった。
  // そのせいで材料・外注・単価待ち・未確定はここへ来られず、直すことも消すこともできなかった。
  // 「前の項目／これでOK」も一覧の並びどおりに送れるようになる。
  const state = () => {
    const s = getState();
    const list = (s.items || []).slice();
    const item = list.find((i) => i.id === currentId);
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
          ${it.kind === '労務' ? `
            <div style="display:flex;gap:8px;padding:10px 4px 10px">
              ${['rough', 'detail'].map((m) => `
                <div data-mode="${m}" style="flex:1;display:flex;align-items:center;justify-content:center;height:44px;
                  border-radius:6px;font-size:15px;cursor:pointer;
                  ${mode === m ? 'background:#fff;color:#1B3A5C;font-weight:700'
                    : 'border:1px solid rgba(255,255,255,0.35);color:rgba(255,255,255,0.85);font-weight:500'}"
                  >${m === 'rough' ? 'ざっくり' : 'くわしく'}</div>`).join('')}
            </div>` : '<div style="height:10px"></div>'}
        </div>

        <div class="scroll est-list-scroll" style="padding:12px">
          ${mode === 'detail' && it.kind === '労務'
            ? detailBody(it, s, steps)
            : isTimeKind(it) ? roughBody(it, s, rate, steps) : moneyBody(it, s)}
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
  // 【労務は工数で数える】2026/8/7
  //   1工数＝8時間。刻みは0.5工数（＝4時間）。
  //   保存は今までどおり時間（hours）。見せるときに8で割り、入れるときに8を掛ける。
  //   すでに入っている見積もそのまま工数で出る。金額の出し方は変えていない。
  //   移動だけは時間のまま。片道1時間を0.125工数と書いても読めない。
  function roughBody(it, s, rate, steps) {
    const travel = it.kind === '移動';
    const stepH = travel ? 1 : HOURS_PER_KOSU / 2;   // 移動は±1h／労務は±0.5工数
    const amt = itemAmount(it, s.rates, s.unitRates) || 0;
    const b = itemBreakdown(it, s.rates, s.unitRates);
    const row = (l, v) => `
      <div style="display:flex;align-items:center;justify-content:space-between;height:36px;font-size:13.5px;color:#4A5A6B">
        <span>${l}</span><span style="font-family:var(--mono);font-weight:600;color:#16202B">${YEN(v)}</span></div>`;

    return `
      <div style="background:#fff;border:1px solid #D9DEE4;border-radius:6px;padding:14px">
        <div style="font-size:16px;font-weight:700;color:#16202B;line-height:1.4">${esc(it.name || '')}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:10px">
          <div style="font-size:13px;color:#4A5A6B">${esc(travel ? '移動労務' : (it.trade || ''))}
            <b data-np style="font-family:var(--mono);font-weight:700;color:#16202B;cursor:pointer">${it.persons ?? 0}</b>人 ×
            ${travel
              ? `<b data-nh style="font-family:var(--mono);font-weight:700;color:#16202B;cursor:pointer">${it.hours ?? 0}</b>h`
              : `<b data-nk style="font-family:var(--mono);font-weight:700;color:#16202B;cursor:pointer">${kosuText(it.hours)}</b>工数`}</div>
          <div style="display:flex;gap:6px;flex:none">
            <button data-d="-${stepH}" style="width:68px;height:44px;background:#fff;border:1px solid #C3CBD4;border-radius:6px;
              color:#1B3A5C;font-family:var(--mono);font-size:14px;font-weight:700;cursor:pointer">−${travel ? '1h' : '0.5'}</button>
            <button data-d="${stepH}" style="width:68px;height:44px;background:#fff;border:1px solid #C3CBD4;border-radius:6px;
              color:#1B3A5C;font-family:var(--mono);font-size:14px;font-weight:700;cursor:pointer">＋${travel ? '1h' : '0.5'}</button>
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
        ${row(travel
          ? `移動労務（${rate ? rate.toLocaleString('ja-JP') : '—'}円/h）`
          : `労務費（${esc(it.trade || '')} ${rate ? (rate * HOURS_PER_KOSU).toLocaleString('ja-JP') : '—'}円/工数）`, b.amount)}
        ${b.depreciation ? row('損料 5%（吊具・工具）', b.depreciation) : ''}
        ${b.welfare ? row('法定福利費 16%（労務費のみ）', b.welfare) : ''}
      </div>

      <button id="d-del" style="width:100%;background:none;border:0;color:#b3261e;font-family:var(--font);
        font-size:14px;padding:22px 0 8px;cursor:pointer">この項目を消す</button>`;
  }

  // ---------- 材料・外注・単価待ち・未確定（人数×時間で数えないもの） ----------
  // ここが無かったので、材料と外注は直すことも消すこともできなかった。
  // 未確定の3択（この金額を使う／金額を直す／単価待ちにする）もここに置く。
  // AIが出した金額は人が押すまで合計に入らない、という決めごとは変えていない。
  // ---------- 材料の数え方（定尺 × 本数） ----------
  // 現場と発注は本数で数える。定尺は単価マスターから引いてある（js/rough-material.js）。
  // 一覧は見るだけ、直すのはここ、という決めごとに従ってここにだけ置く。
  // 定尺は候補が2つ以上あるときだけ押せる（1つしかないなら押しても何も変わらない＝芯5）。
  function matBody(it) {
    if (it.kind !== '材料') return '';
    const line = materialCountText(it);
    if (!line) return '';
    const opts = (it.stockOptions || []).filter((v) => typeof v === 'number');
    const canPickLen = opts.length > 1;
    const cell = (id, label, value, on) => `
      <div style="flex:1;min-width:0">
        <div style="font-size:11.5px;color:#8A96A3;padding-bottom:4px">${label}</div>
        <button ${on ? `id="${id}"` : ''} style="width:100%;height:48px;background:${on ? '#fff' : '#F4F6F8'};
          border:1px solid #D9DEE4;border-radius:6px;font-family:var(--mono);font-size:17px;font-weight:700;
          color:#16202B;cursor:${on ? 'pointer' : 'default'}">${value}</button>
      </div>`;
    return `
      <div style="font-size:13px;font-weight:700;color:#1B3A5C;padding:18px 2px 8px">数え方</div>
      <div style="background:#fff;border:1px solid #D9DEE4;border-radius:6px;padding:12px 14px">
        <div style="font-size:12.5px;color:#6B7783;font-family:var(--mono);padding-bottom:10px">${esc(line)}</div>
        ${it.perLengthM ? `
          <div style="display:flex;gap:10px">
            ${cell('mt-len', '定尺', `${it.perLengthM}m`, canPickLen)}
            ${cell('mt-qty', '本数', `${it.qty ?? '—'}本`, true)}
          </div>
          <div style="font-size:11.5px;color:#8A96A3;line-height:1.7;padding-top:8px">
            合計の長さを定尺で割って、切り上げた本数です。余分が要るときは本数を直してください。
            ${canPickLen ? `<br>この呼び径の定尺: ${opts.map((v) => v + 'm').join('・')}` : ''}
          </div>`
        : `<div style="font-size:12px;color:#8A560F;line-height:1.7">
            単価マスターに定尺が見つからなかったので、合計の長さのままにしてあります。<br>
            ${esc(it.matWhy || '')}</div>`}
      </div>`;
  }

  function moneyBody(it, s) {
    const amt = itemAmount(it, s.rates, s.unitRates);
    const b = itemBreakdown(it, s.rates, s.unitRates);
    const row = (l, v) => `
      <div style="display:flex;align-items:center;justify-content:space-between;height:36px;font-size:13.5px;color:#4A5A6B">
        <span>${l}</span><span style="font-family:var(--mono);font-weight:600;color:#16202B">${YEN(v)}</span></div>`;
    const BIG = 'width:100%;height:52px;border-radius:6px;font-family:var(--font);font-size:16px;font-weight:700;cursor:pointer';

    // 未確定 … よつばの単価と相場を並べて、人に押させる
    if (it.state === '未確定') {
      const y = yotsubaAmount(it, s.rates, s.unitRates);
      const m = marketAmount(it);
      return `
        <div style="background:#fff;border:1px dashed #C3CBD4;border-radius:6px;padding:14px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <div style="font-size:16px;font-weight:700;color:#16202B;line-height:1.4">${esc(it.name || '')}</div>
            <span style="font-size:11px;font-weight:700;color:#7A8794;border:1px solid #D2D8E0;border-radius:3px;
              padding:2px 6px;flex:none">未確定</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;padding-top:10px;font-size:13.5px;color:#6B7783">
            <span>よつばの単価</span>
            <span style="font-family:var(--mono)${y != null ? ';font-size:20px;font-weight:700;color:#16202B' : ''}">${y == null ? 'なし' : YEN(y)}</span></div>
          <div style="display:flex;align-items:center;justify-content:space-between;padding-top:6px;font-size:13.5px;color:#6B7783">
            <span style="display:flex;align-items:center;gap:6px">世の中の相場
              <span style="font-size:10.5px;font-weight:700;color:#1F6B5B;background:#E3F0EC;border-radius:3px;padding:2px 5px">相場</span></span>
            <span style="font-family:var(--mono);font-size:24px;font-weight:700;color:#1F6B5B;letter-spacing:-.01em">${m == null ? '—' : YEN(m)}</span></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;padding-top:12px">
          <button id="m-use" data-src="${y != null ? 'yotsuba' : 'market'}"
            style="${BIG};background:${NAVY_GRAD};border:0;color:#fff">この金額を使う</button>
          <button id="m-edit" style="${BIG};background:#fff;border:1px solid #C3CBD4;color:#1B3A5C">金額を直す</button>
          <button id="m-pend" style="${BIG};background:#fff;border:1px solid #C3CBD4;color:#1B3A5C">単価待ちにする</button>
        </div>
        <div style="font-size:12px;color:#8A96A3;padding:10px 2px 0;line-height:1.7">
          どれか押すまで合計に入りません。<br>あとからここで何度でも直せます。</div>
        ${matBody(it)}

        <button id="d-del" style="width:100%;background:none;border:0;color:#b3261e;font-family:var(--font);
          font-size:14px;padding:22px 0 8px;cursor:pointer">この項目を消す</button>`;
    }

    // 単価待ち … 合計に入らない。空けたまま先へ進める（芯2）
    if (it.state === '単価待ち') {
      return `
        <div style="background:#fff;border:1px solid #D9DEE4;border-left:4px solid #BA7517;border-radius:6px;padding:14px">
          <div style="font-size:16px;font-weight:700;color:#16202B;line-height:1.4">
            <span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:700;color:#fff;
              background:#BA7517;border-radius:3px;padding:2px 6px;vertical-align:2px;margin-right:5px">
              <span style="font-size:12px;display:grid;place-items:center">${icons.clock}</span>単価待ち</span>${esc(it.name || '')}</div>
          <div style="font-size:12.5px;color:#8A96A3;padding-top:8px;line-height:1.7">
            聞いてから入れます。入れるまで合計には入りません。</div>
        </div>
        <button id="m-edit" style="${BIG};background:${NAVY_GRAD};border:0;color:#fff;margin-top:12px">金額を入れる</button>
        ${matBody(it)}

        <button id="d-del" style="width:100%;background:none;border:0;color:#b3261e;font-family:var(--font);
          font-size:14px;padding:22px 0 8px;cursor:pointer">この項目を消す</button>`;
    }

    // 確定した材料・外注
    const isMarket = it.chosen === 'market';
    return `
      <div style="background:#fff;border:1px solid #D9DEE4;border-radius:6px;padding:14px">
        <div style="font-size:16px;font-weight:700;color:#16202B;line-height:1.4">${esc(it.name || '')}</div>
        <div style="font-size:12.5px;color:#8A96A3;padding-top:4px">${esc(it.kind)}費${it.kind === '外注' ? ' 1式' : ''}</div>
        ${isMarket ? `<div style="padding-top:8px"><span style="display:inline-flex;align-items:center;gap:3px;
          font-size:11px;font-weight:700;color:#1F6B5B;background:#E3F0EC;border-radius:3px;padding:2px 6px">
          <span style="font-size:12px;display:grid;place-items:center">${icons.check}</span>相場で確定</span></div>` : ''}
        <div style="text-align:right;padding-top:10px">
          <span style="font-family:var(--mono);font-size:28px;font-weight:700;color:#1B3A5C;letter-spacing:-.01em">${YEN(amt || 0)}</span></div>
      </div>
      <button id="m-edit" style="${BIG};background:#fff;border:1px solid #C3CBD4;color:#1B3A5C;margin-top:12px">金額を直す</button>

      <div style="font-size:13px;font-weight:700;color:#1B3A5C;padding:18px 2px 8px">この項目にかかるもの</div>
      <div style="background:#fff;border:1px solid #D9DEE4;border-radius:6px;padding:4px 14px">
        ${row(`${esc(it.kind)}費`, b.amount)}
        ${b.depreciation ? row('損料 5%（吊具・工具）', b.depreciation) : ''}
      </div>
      ${matBody(it)}

      <button id="d-del" style="width:100%;background:none;border:0;color:#b3261e;font-family:var(--font);
        font-size:14px;padding:22px 0 8px;cursor:pointer">この項目を消す</button>`;
  }

  // ---------- くわしく ----------
  // 【この中だけ時間で入れる】門型4h・玉掛け1h のような段取りは、
  // 0.5工数（＝4時間）刻みでは刻めない。だから手順の行は時間のまま。
  // 見出しに「（時間で入れます）」と書いて、ここだけ時間だと分かるようにしている。
  // 単位を画面に3つ（工数・人時・h）出すと、中身が合っていても見る人が迷う。
  //
  // 【「のべ」と書く理由】stepsManHours は人時（人数×時間の合計）を返す。
  // それを8で割って工数にしている（2人×8h ＝ 16人時 ＝ 2工数）。
  //   ざっくり側 … 2人 × 1工数   ← 1人あたり（8h ÷ 8）
  //   ここ       … のべ 2工数    ← 2人ぶんを足したもの
  // 同じ項目で 1工数 と 2工数 が並ぶので、どちらの数え方かを言葉で分ける。
  // 「合計」だと1人あたりと区別が付かない。この2文字を外さないこと。
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
        <span style="font-size:13px;font-weight:700;color:#1B3A5C">手順（時間で入れます）</span>
        <span style="font-family:var(--mono);font-size:13px;font-weight:700;color:#7A8794">${steps.length}つ</span>
        <span style="flex:1;height:1px;background:#D2D8E0"></span>
        <span style="font-size:12px;color:#4A5A6B">のべ <b style="font-family:var(--mono)">${kosuText(stepsManHours(steps))}</b>工数</span>
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
    // 工数で受けて、8を掛けて時間で保存する（保存の形は変えていない）
    const nk = q('[data-nk]');
    if (nk) nk.addEventListener('click', () => {
      openNumpad({
        title: '工数', value: hoursToKosu(it.hours) ?? '', unit: '工数', allowDecimal: true,
        hint: '1工数 ＝ 8時間（1人が1日）',
        onDone: (n) => { if (n != null) save({ hours: kosuToHours(n) }); },
      });
    });

    const ex = q('#d-expand');
    if (ex) ex.addEventListener('click', async () => {
      if (!steps.length) {
        // 【出しても金額は変わらない】いまの人数×時間をそのまま1行目にする
        await saveSteps([newStep({
          name: it.name || '作業', trade: it.trade, persons: it.persons, hours: it.hours, source: 'human',
        })]);
        // 手順は時間で入れるので、ここも「人数と時間」と言う（工数と言わない）
        toast('いまの人数と時間を1行目にしました。ここから足せます');
      }
      mode = 'detail'; paint();
    });

    // 材料・外注・単価待ち・未確定（金額そのものを直す）
    const mEdit = q('#m-edit');
    if (mEdit) mEdit.addEventListener('click', () => {
      const cur = itemAmount(it, s.rates, s.unitRates) ?? it.manualAmount ?? it.marketAmount ?? '';
      openNumpad({
        title: it.name || '金額', value: typeof cur === 'number' ? Math.round(cur) : '',
        unit: '円', allowDecimal: false,
        onDone: async (n) => {
          if (n == null) return;
          try {
            // 外注は1式なので金額をそのまま持つ。材料は単価の上書きとして残す
            // （誰がいつ直したかを履歴に残すため overrideItemAmount を通す）
            if (it.kind === '外注') await updateItem(roughId, it.id, { amount: n, state: '確定', chosen: 'yotsuba' });
            else await overrideItemAmount(roughId, it.id, n, local.get('staff', ''));
          } catch (e) { console.error(e); toast('保存できませんでした'); }
        },
      });
    });
    // ---------- 材料の数え方を直す ----------
    // 本数は現場が直せる（切り上げただけの本数に、余分を足したいことがある）。
    // 定尺を選び直したときは、合計の長さから本数を出し直す。人が直した本数は残さない
    //（定尺が変われば要る本数も変わるので、そのまま残すとつじつまが合わなくなる）
    const mtQty = q('#mt-qty');
    if (mtQty) mtQty.addEventListener('click', () => {
      openNumpad({
        title: `${it.name || '材料'} の本数`, value: it.qty ?? '', unit: '本', allowDecimal: false,
        onDone: async (n) => {
          if (n == null || n < 0) return;
          try { await updateItem(roughId, it.id, { qty: n }); }
          catch (e) { console.error(e); toast('保存できませんでした'); }
        },
      });
    });
    const mtLen = q('#mt-len');
    if (mtLen) mtLen.addEventListener('click', () => {
      const opts = (it.stockOptions || []).filter((v) => typeof v === 'number');
      const ov2 = openOverlay({ narrow: true });
      ov2.el.innerHTML = `
        <div class="page-head"><div class="bar"><button class="icon-btn" id="ml-x">←</button><span class="ttl">定尺を選ぶ</span></div></div>
        <div class="page-body"><div class="form-page">
          <div style="font-size:13px;color:var(--muted);padding-bottom:10px;line-height:1.7">
            ${esc(it.name || '材料')}<br>合わせて ${it.totalM ?? '—'}m ぶんです</div>
          ${opts.map((v) => `<button class="btn btn-block" style="height:56px;margin-bottom:8px"
            data-len="${v}">${v}m　→　${piecesFor(it.totalM, v) ?? '—'}本</button>`).join('')}
        </div></div>`;
      ov2.el.querySelector('#ml-x').addEventListener('click', ov2.close);
      ov2.el.querySelectorAll('[data-len]').forEach((el) => el.addEventListener('click', async () => {
        const v = Number(el.dataset.len);
        ov2.close();
        try { await updateItem(roughId, it.id, { perLengthM: v, qty: piecesFor(it.totalM, v) }); }
        catch (e) { console.error(e); toast('保存できませんでした'); }
      }));
    });

    const mUse = q('#m-use');
    if (mUse) mUse.addEventListener('click', () => {
      decideItem(roughId, it.id, mUse.dataset.src, local.get('staff', '')).catch(() => toast('保存できませんでした'));
    });
    const mPend = q('#m-pend');
    if (mPend) mPend.addEventListener('click', () => {
      markPending(roughId, it.id).catch(() => toast('保存できませんでした'));
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
