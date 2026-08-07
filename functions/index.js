// ============================================================
// 受付（Firebase Functions）— 写真から見積のAI呼び出し
//
// 【なぜ受付が要るか】
// アプリは静的サイト（GitHub Pages）なので、APIキーを持てない。
// ブラウザに置いたキーは誰でも読める。だからキーはここ（サーバー側）に置き、
// スマホ → 受付 → Anthropic の順で通す。スマホはキーを一度も見ない。
//
// 【キーの置き場所】Google Secret Manager
//   リポジトリにも、このファイルにも、環境変数ファイルにも書かない。
//   入れ方:  firebase functions:secrets:set ANTHROPIC_API_KEY
//   （打った値は画面に出ず、Secret Manager に入る。あとから読み出せない）
//
// 【この受付がやらないこと】
//   ・金額の計算をしない。諸経費・法定福利費・損料・税は rough-calc.js の仕事。
//     ここが返すのは「1項目ごとの生の数字」だけ。
//   ・合計に勝手に入れない。返す項目は必ず state:'未確定'。
//     人が「この金額を使う」を押すまで合計に入らない（README v2 の約束）。
// ============================================================

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');

admin.initializeApp();

// Secret Manager の入れ物の名前。値はここには書かない
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const MODEL = 'claude-opus-5';
const MAX_PHOTOS = 8;                       // 1回に読ませる枚数の上限（料金の歯止め）
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;   // 写真の合計サイズの上限
const PHOTO_PREFIX = 'roughPhotos/';        // ここ以外のファイルは読ませない

// ============================================================
// 返してもらう形（構造化出力）
// この形から外れた返事は API 側で弾かれるので、JSONの取り違えが起きない。
// 分からない数字は 0 ではなく null で返させる。0だと「タダ」の意味になる。
// ============================================================
const STEP = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'trade', 'persons', 'hours'],
  properties: {
    name: { type: 'string', description: '手順の名前。例）門型 組立・解体' },
    trade: { type: ['string', 'null'], description: '職種。現場工事／整備／溶接加工／塗装 など' },
    persons: { type: ['number', 'null'], description: '人数' },
    hours: { type: ['number', 'null'], description: '時間' },
  },
};

const ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'name', 'state', 'trade', 'persons', 'hours', 'marketAmount', 'qty', 'unit', 'cost', 'steps'],
  properties: {
    kind: { type: 'string', enum: ['材料', '労務', '移動', '外注'] },
    name: { type: 'string', description: '見積書に出す項目名' },
    state: { type: 'string', enum: ['未確定'], description: '必ず未確定。人が押すまで合計に入れない' },
    trade: { type: ['string', 'null'], description: '労務のときの職種' },
    persons: { type: ['number', 'null'], description: '労務・移動のときの人数' },
    hours: { type: ['number', 'null'], description: '労務・移動のときの時間' },
    marketAmount: { type: ['number', 'null'], description: '世の中の相場（税抜・売値）。分からなければ null' },
    qty: { type: ['number', 'null'], description: 'よつばの単価で出せるときの数量' },
    unit: { type: ['string', 'null'], description: '数量の単位。本／枚／式 など' },
    cost: { type: ['number', 'null'], description: 'よつばの単価で出せるときの1つあたりの原価' },
    steps: { type: 'array', items: STEP, description: '労務の手順の内訳。無ければ空の配列' },
  },
};

const QUESTION = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'about', 'kind', 'options'],
  properties: {
    text: { type: 'string', description: '職人に見せる質問文。一文で、専門用語を避ける' },
    about: { type: ['string', 'null'], description: '何についての質問か。短く' },
    kind: { type: 'string', enum: ['choice', 'photo', 'free'] },
    options: { type: 'array', items: { type: 'string' }, description: 'choice のときの選択肢。2〜3個' },
  },
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'questions'],
  properties: {
    items: { type: 'array', items: ITEM },
    questions: { type: 'array', items: QUESTION },
  },
};

// ============================================================
// 毎回聞くこと（職人には見えない。アプリが裏で付ける）
// 出どころ: js/rough-generate.js の【毎回聞くこと】①〜④
// ============================================================
const SYSTEM = `あなたは鉄工所（よつば建設工業）の見積を手伝います。
現場の写真と、職人が打った一言から、概算見積の項目を出してください。

やること:
① この工事でやることを、順番に並べる
② それぞれ、何人で何時間かかるかを出す
③ それぞれ、世の中の相場ではいくらかを出す
④ 写真から分からないことを、質問にする

守ること:
- 合計・諸経費・法定福利費・損料・消費税は計算しないでください。アプリが計算します。
  あなたが返すのは「1項目ごとの生の数字」だけです。
- 金額が分からない材料・外注は、0ではなく null にしてください。
  0は「タダ」の意味になります。nullなら「単価待ち」として空けたまま先へ進めます。
- 写真から読み取れないこと（寸法・型式・kW・数量）を推測で埋めないでください。
  分からないものは null にして、④の質問に回してください。
- 現場までの移動は kind:'移動' の項目を1つ入れてください（人数と時間だけ。距離は現場が入れます）。
- 項目名は見積書にそのまま出ます。職人と元請けの両方が読んで分かる言葉にしてください。
- 質問は多くて3つまで。答えなくても先へ進めるものにしてください。

職種の呼び方は「現場工事」「整備」「溶接加工」「塗装」を使ってください。`;

// ============================================================
// 受付本体
//   呼び方: httpsCallable(functions, 'estimateFromPhotos')({ workType, oneLiner, photoPaths })
//   返り値: { items, questions }
// ============================================================
exports.estimateFromPhotos = onCall(
  {
    region: 'asia-northeast1',
    secrets: [ANTHROPIC_API_KEY],
    // 写真を読んで考えるので長め。claude-opus-5 は既定で考えるぶん時間がかかる。
    // ここを短くすると、考え終わる前に打ち切られて「AIにつながりませんでした」になる。
    // スマホ側の待ち時間（rough-generate.js の timeout）と必ず同じにすること。
    timeoutSeconds: 540,
    memory: '1GiB',
    cors: true,
  },
  async (request) => {
    // ---------- 誰が呼んだか ----------
    // アプリは匿名認証。ログイン済みの端末からしか通さない。
    // ※匿名なので「アプリ経由かどうか」までしか分からない。
    //   もっと締めるなら App Check を足す（いまは入れていない）。
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'アプリからログインしてください');
    }

    const { workType, oneLiner, photoPaths } = request.data || {};
    if (!workType || typeof workType !== 'string') {
      throw new HttpsError('invalid-argument', '工事の種類がありません');
    }

    // ---------- 写真を集める ----------
    const blocks = [];
    let total = 0;
    const bucket = admin.storage().bucket();

    for (const path of (Array.isArray(photoPaths) ? photoPaths : []).slice(0, MAX_PHOTOS)) {
      // 【必ず確かめる】概算の写真置き場の中だけ。
      // ここを見ないと、呼んだ人がバケット内の好きなファイルを読ませられてしまう。
      if (typeof path !== 'string' || !path.startsWith(PHOTO_PREFIX) || path.includes('..')) {
        throw new HttpsError('invalid-argument', '写真の置き場所が不正です');
      }
      const file = bucket.file(path);
      const [meta] = await file.getMetadata().catch(() => [null]);
      if (!meta) continue;                         // 消された写真は飛ばす

      const size = Number(meta.size) || 0;
      if (total + size > MAX_TOTAL_BYTES) break;   // 上限まで来たら残りは送らない
      total += size;

      const [buf] = await file.download();
      const data = buf.toString('base64');
      const mime = meta.contentType || '';

      if (mime === 'application/pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
      } else if (/^image\/(jpeg|png|gif|webp)$/.test(mime)) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data } });
      }
      // それ以外の形式は黙って飛ばす（HEIC等はアプリ側でjpegに変換されている前提）
    }

    blocks.push({
      type: 'text',
      text: [
        `工事の種類: ${workType}`,
        `すること: ${oneLiner || '（一言なし。写真から読み取ってください）'}`,
        blocks.length ? '' : '※写真がありません。工事の種類とすることだけで出してください。',
      ].filter(Boolean).join('\n'),
    });

    // ---------- Anthropic を呼ぶ ----------
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

    // 【max_tokens は「考えるぶん」と「答えるぶん」の合計の上限】
    //   claude-opus-5 は指定しなくても考える。16000 だと考えるだけで使い切り、
    //   答えが途中で切れて JSON が壊れる（＝「AIの返事を読めませんでした」）。だから多めに取る。
    // 【stream を使う理由】
    //   max_tokens が大きいと、待っているだけの通信が途中で切られることがある。
    //   流しながら受け取れば切れない。受け取り終わった全文は finalMessage() で取る。
    let res;
    try {
      res = await anthropic.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        system: SYSTEM,
        output_config: {
          effort: 'high',
          format: { type: 'json_schema', schema: SCHEMA },
        },
        messages: [{ role: 'user', content: blocks }],
      }).finalMessage();
    } catch (e) {
      logger.error('Anthropic 呼び出しに失敗', e);
      throw new HttpsError('unavailable', 'AIにつながりませんでした。ひな形から出してください');
    }

    // 断られたときは content が空。先に stop_reason を見る
    if (res.stop_reason === 'refusal') {
      logger.warn('AIが応答を断りました', res.stop_details);
      throw new HttpsError('unavailable', 'AIが答えられませんでした。ひな形から出してください');
    }

    // 考えたぶんのブロックが先に来るので、text を探して取る
    const text = (res.content || []).find((b) => b.type === 'text')?.text;
    if (!text) {
      logger.error('AIの返事が空でした', { stop_reason: res.stop_reason });
      throw new HttpsError('internal', 'AIの返事を読めませんでした');
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      logger.error('AIの返事がJSONではありませんでした', { head: text.slice(0, 200) });
      throw new HttpsError('internal', 'AIの返事を読めませんでした');
    }

    // ---------- 最後の歯止め ----------
    // 形は API 側で保証されているが、state だけはこちらでも上書きする。
    // 「AIの金額を勝手に合計へ入れない」はこのアプリの土台なので、二重に守る。
    const items = (parsed.items || []).map((it, i) => ({
      ...it,
      state: '未確定',
      source: 'ai',
      order: i,
    }));

    logger.info('項目を出しました', {
      workType,
      photos: blocks.length - 1,
      items: items.length,
      questions: (parsed.questions || []).length,
      usage: res.usage,
    });

    return { items, questions: parsed.questions || [] };
  },
);
