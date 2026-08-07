// ============================================================
// 項目を出す — ひな形 と AI の切り替え口
//
// CLAUDE.md「APIキーの取得と外部送信の了解が未了のうちは、
// Functions と AI 呼び出しを実装しない」— どちらも済んだので実装した。
//   APIキーの取得   … 済（担当k）
//   外部送信の了解  … 済（2026/8/6 社長）
// 切り替えは下の isAiAvailable() 1行。デプロイが済むまでは ひな形のまま。
//
// 【あとから差し込む場所はここ1つだけ】
//   画面（screen-rough.js）は generateItems() しか呼んでいない。
//   下の generateByAi() が動くようになれば、画面は1行も直さずAIに切り替わる。
// ============================================================

import { templateItems, TEMPLATE_LABELS } from './rough-templates.js?v=33';
import { functions, httpsCallable } from './firebase.js?v=33';

// ---------- AIが使えるか ----------
// 画面はこれを見て「AIで出す」か「ひな形から出す」かの見せ方を変える。
//
// 【true にする前に確かめたこと】2026/8/7
//   受付のコード（functions/index.js）… 書いた
//   firebase deploy --only functions  … 済
//   受付が実際に呼べること … 済（外から叩いて確認。
//     Cloud Run の門前払いが消え、受付自身がJSONで返すところまで見た）
//   App Check が弾いていること … 済（鍵を持たない呼び出しは Unauthenticated）
//
// デプロイ前に true にすると、現場が「項目を出す」を押した瞬間に止まる。
// 「動くはず」で true にしないこと。実際に呼んで確かめてから。
// 直すのはこの1行だけ。画面は1行も触らない。
export function isAiAvailable() {
  return true;
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
// 受付を呼ぶ。httpsCallable が匿名認証のトークンを自動で付けるので、
// こちらでトークンを組み立てる必要はない（前は fetch で自前で付ける想定だった）。
// 写真そのものは送らない。Storage の置き場所（path）だけ送り、
// 受付が Storage から読む。スマホから何MBも上げ直さずに済む。
export async function generateByAi({ workType, oneLiner, photos }) {
  // 待ち時間は受付側（functions/index.js の timeoutSeconds）と必ず同じにする。
  // こちらが先に諦めると、向こうは動き続けて料金だけかかる。
  const call = httpsCallable(functions, 'estimateFromPhotos', { timeout: 540000 });
  const paths = (photos || []).map((p) => p.path).filter(Boolean);
  const res = await call({ workType, oneLiner: oneLiner || '', photoPaths: paths });
  const data = res.data || {};
  return {
    source: SOURCES.AI,
    items: data.items || [],
    questions: data.questions || [],
    label: TEMPLATE_LABELS[workType] || workType,
    // 渡した枚数と、受付が実際に読めた枚数。食い違ったら画面で出す（芯4）
    photosSent: paths.length,
    photosRead: data.photosRead ?? null,
    photosSkipped: data.photosSkipped ?? 0,
  };
}
