// ============================================================
// 項目を出す — ひな形 と AI の切り替え口
//
// いまは ひな形だけ。AI呼び出しはまだ入れない。
//   CLAUDE.md「3と4が未了のうちは、Functions と AI 呼び出しを実装しない」
//   3 = APIキーを誰が取るか ／ 4 = データが外部に送られることの了解
//
// 【あとから差し込む場所はここ1つだけ】
//   画面（screen-rough.js）は generateItems() しか呼んでいない。
//   下の generateByAi() が動くようになれば、画面は1行も直さずAIに切り替わる。
// ============================================================

import { templateItems, TEMPLATE_LABELS } from './rough-templates.js?v=33';

// ---------- AIが使えるか ----------
// Firebase Functions の受付ができて、社長の了解が取れたら true になる。
// 画面はこれを見て「AIで出す」か「ひな形から出す」かの見せ方を変える。
export function isAiAvailable() {
  return false;
}

export const SOURCES = { TEMPLATE: 'template', AI: 'ai' };

// ---------- 項目を出す ----------
// 画面はこれだけを呼ぶ。中身が ひな形 でも AI でも、返す形は同じ。
//   opts: { workType, oneLiner, photos }
//   返り値: { source, items, questions }
//     items     … 概算の項目の配列（rough-store.newItem に渡せる形）
//     questions … ききたいこと。ひな形のときは空
export async function generateItems(opts = {}) {
  if (isAiAvailable()) return generateByAi(opts);
  return generateByTemplate(opts);
}

export function generateByTemplate({ workType }) {
  return {
    source: SOURCES.TEMPLATE,
    items: templateItems(workType),
    questions: [],
    label: TEMPLATE_LABELS[workType] || workType,
  };
}

// ============================================================
// ここから下が、AIを入れるときに書くところ
// ============================================================
//
// 【呼び方】スマホ → Firebase Functions（キーはここ）→ Claude / ChatGPT
//   静的サイトなのでキーを直接持てない。必ず受付(Functions)を経由する。
//
// 【毎回聞くこと】アプリが裏で付ける。職人には見えない。
//   ① この工事でやることを、順番に並べてください
//   ② それぞれ、何人で何時間かかりますか
//   ③ それぞれ、世の中の相場ではいくらですか
//   ④ 写真から分からないことを、質問にしてください
//   工事の種類で文章が切り替わる。設定画面から直せること（触れるのは社長とkだけ）。
//
// 【使い分け（実測で決めた）】
//   図面・写真を読む → Claude ／ 作業項目を並べる → ChatGPT ／ 人工・相場 → どちらでも
//   寸法・数量・kW・型式だけ2社で答え合わせ。一致→自動、食い違い→④の質問にする。
//   一致しても元の写真は必ず画面に残す（2社が同じ間違いをすることがある）。
//
// 【返す形の約束】ここを守れば画面は直さなくてよい
//   items[]     … kind:'材料'|'労務'|'移動'|'外注'
//                 **state は必ず '未確定' で返すこと**（AIの金額は勝手に合計へ入れない）
//                 労務: trade / persons / hours、材料: marketAmount（相場・売値）
//                 よつばの単価が出せるものは qty / cost も入れる（2つ並べて出すため）
//                 steps[] … 手順（門型・玉掛け等）。無くてよい
//   questions[] … { text, about, kind:'choice'|'photo'|'free', options[] }
//
export async function generateByAi({ workType, oneLiner, photos }) {
  // TODO: Functions の受付ができたらここを実装する。
  //   const res = await fetch(FUNCTIONS_URL + '/estimateFromPhotos', {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json',
  //                Authorization: 'Bearer ' + await auth.currentUser.getIdToken() },
  //     body: JSON.stringify({ workType, oneLiner, photoPaths: photos.map((p) => p.path) }),
  //   });
  //   const data = await res.json();
  //   return { source: SOURCES.AI, items: data.items, questions: data.questions };
  throw new Error('AIはまだ使えません（Functionsの受付が未実装）');
}
