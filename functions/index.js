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
// 写真の合計サイズの上限。
// アプリ側が長辺2000pxに縮めてから上げるので、1枚あたり1MBを超えない見込み。
// 12MBのままだと、縮小前の写真が残っている見積で無言で落ちるので広げておく。
// ここを超えたぶんは飛ばすが、飛ばしたことは必ず記録して画面にも返す。
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
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
  required: ['kind', 'name', 'state', 'trade', 'persons', 'hours', 'marketAmount',
    'totalQty', 'totalUnit', 'matKind', 'matMaterial', 'matSize', 'qty', 'unit', 'cost', 'steps'],
  properties: {
    kind: { type: 'string', enum: ['材料', '労務', '移動', '外注'] },
    name: { type: 'string', description: '見積書に出す項目名' },
    state: { type: 'string', enum: ['未確定'], description: '必ず未確定。人が押すまで合計に入れない' },
    // 【この3つが「よつばの単価」の材料】2026/8/8
    // よつばの単価は 職種の単価 × 人数 × 時間 で出る（js/rough-calc.js yotsubaBase）。
    // 2026/8/7 にこの3つを「推測してはいけないもの」に入れた日、よつばの単価が消えた。
    // 人工の見立ては下の①②で聞いていることそのもので、写真から読み取る事実ではない。
    // ここに「分からなければ null」と書き戻さないこと。相場と同じ轍になる。
    trade: {
      type: ['string', 'null'],
      description: '職種。労務では必ず入れる。渡した職種の一覧にある名前をそのまま使う',
    },
    persons: { type: ['number', 'null'], description: '人数。労務・移動では必ず入れる' },
    hours: { type: ['number', 'null'], description: '時間。労務・移動では必ず入れる' },
    // 【「分からなければ null」と書かないこと】2026/8/7
    // 前はそう書いていた。それが楽な逃げ道になり、20項目すべて null で返る回があった。
    // 相場が入らないと画面が「よつばの単価」1本になり、2つ並べて見せる意味が消える。
    marketAmount: {
      type: ['number', 'null'],
      description: '世の中の相場（税抜・売値）。必ず入れる。写真で細部が分からなくても、'
        + 'その工種・その規模の世間並みの金額を入れる。本当に見当が付かないときだけ null',
    },
    // ---------- 材料を数えるための欄（2026/8/8） ----------
    // 【本数はAIに数えさせない】アプリが数える。
    //   定尺（4m／5.5m など）は単価マスターの品名が持っていて、材料ごとに違う。
    //   AIに定尺を言わせると、マスターに無い長さの品名ができて単価が引けず、
    //   よつばの単価が黙って消える。割り算（60m÷4m＝15本）も算数なので、
    //   間違えても誰も気づけない。だからAIには「総量」までを言わせ、
    //   定尺と本数はアプリが単価マスターから出す（js/rough-material.js）。
    totalQty: {
      type: ['number', 'null'],
      description: '総量。長さもの（配管・アングル等）は合計の長さ、それ以外は個数。'
        + '写真や一言に書いてあるときはそのまま使う。書いていなければ null',
    },
    totalUnit: {
      type: ['string', 'null'],
      description: '総量の単位。長さものは m。個数のものは 枚／個／組／式。本数（本）にはしない',
    },
    matKind: {
      type: ['string', 'null'],
      description: '材料の種類。渡した「材料の種類の一覧」から選ぶ。一覧に無いものは null',
    },
    matMaterial: { type: ['string', 'null'], description: '材質。SUS304／SUS316L／SS400 など。分からなければ null' },
    matSize: {
      type: ['string', 'null'],
      description: '呼び径や形。配管は 40A のように呼び径。形材は L-6x65x65 のように形。肉厚は入れない',
    },
    // qty・unit はアプリが入れる欄（定尺から出した本数）。AIは触らない
    qty: { type: ['number', 'null'], description: 'アプリが入れる欄。必ず null' },
    unit: { type: ['string', 'null'], description: 'アプリが入れる欄。必ず null' },
    // よつばの仕入れ値。単価マスター（1,567品目）の数字で、AIには分からない。
    // ここを埋めさせると、作り話の金額が「よつばの単価」の顔をして出る。必ず null。
    cost: { type: ['number', 'null'], description: 'よつばの仕入れ値。あなたには分からないので必ず null' },
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
//
// 【2026/8/8 に直したこと — 同じ間違いを2度した】
//   8/7: 相場が出なかったので「相場は必ず入れる」を足した。
//        そのとき同時に、禁止リストに trade・persons・hours を名指しで足してしまった。
//        よつばの単価はその3つから出るので、今度はよつばの単価が消えた。
//   直し方の筋: **片方を強めるときは、もう片方も同じ強さで書く。**
//   よつばの単価と相場は2つで1組。片方だけでは現場が比べられず、画面の意味が消える。
// ============================================================
function systemPrompt(trades, matKinds) {
  return `あなたは鉄工所（よつば建設工業）の見積を手伝います。
現場の写真と、職人が打った一言から、概算見積の項目を出してください。

やること:
① この工事でやることを、順番に並べる
② それぞれ、何人で何時間かかるかを出す（必ず入れる）
③ それぞれ、世の中の相場ではいくらかを出す（必ず入れる）
④ 写真から分からないことを、質問にする

守ること:
- 合計・諸経費・法定福利費・損料・消費税は計算しないでください。アプリが計算します。
  あなたが返すのは「1項目ごとの生の数字」だけです。

- 【必ず入れるもの — 2つで1組】
  現場はこの2つを画面に並べて見比べ、どちらの金額を使うかを決めます。
  片方しか無い項目は比べられないので、現場では使えません。両方入れてください。

  (1) よつばの単価を出すための数字 … 労務と移動の trade・persons・hours（上の②）
      職種は次の中から選んでください: ${trades.join('・')}
      この一覧に無い呼び方（例「配管工」）を書くと、アプリが単価表を引けず
      よつばの単価が出ません。近いものを一覧から選んでください。
      人工の見立ては②で聞いていることそのもので、写真から読み取る事実ではありません。
      写真で細部が分からなくても、その工種・その規模で普通どれだけかかるかを入れてください。

  (2) 世の中の相場 … marketAmount（税抜・売値）。材料・労務・移動・外注のどれにも入れます（上の③）。
      相場はもともと当てにいく数字です。型式が分からない材料でも、
      同じ用途の一般的なものの相場を入れてください。
      ※この金額がそのまま客に出るわけではありません。現場が「よつばの単価」と
        見比べるための目安です。人が押すまで合計には入りません。

  (1)(2) とも、本当に見当が付かないときだけ null にしてください。null は例外です。

- 【材料の数え方】現場と発注は本数で数えます。ただし**本数はあなたが出さないでください。**
  定尺（4m・5.5m など）は材料ごとに違い、よつばの単価表が持っています。
  あなたは「合わせて何mか」までを出してください。定尺で割って本数にするのはアプリの仕事です。

  ・totalQty / totalUnit … 長さもの（配管・アングル・平鋼など）は **合計の長さを m で**。
      例）40Aのステンレス配管が合わせて60m要る → totalQty: 60, totalUnit: "m"
      **「本」で答えないでください。** 定尺を知らずに本数を出すと、必ずずれます。
      枚・個・組で数えるもの（フランジ・エルボ・パッキン等）は、その単位のままでかまいません。
  ・matKind … 材料の種類。次の一覧から選んでください: ${matKinds.join('・')}
      一覧に無いもの（ボルト・塗料など）は null にしてください。
  ・matMaterial … 材質（SUS304／SUS316L／SS400 など）。分からなければ null。
  ・matSize … 呼び径や形。配管は「40A」。形材は「L-6x65x65」。**肉厚は入れないでください。**
      定尺は呼び径で決まり、肉厚では変わりません。

- 【推測してはいけないもの】これは上の(1)(2)には掛かりません。掛けないでください。
  写真にも一言にも書いていない 寸法・型式・kW・数量 を推測で埋めないこと。欄でいうと2つだけです。
  ・totalQty（総量） … 写真や一言に書いてあるときはそのまま使う。書いていなければ null
  ・cost（よつばの仕入れ値） … 単価マスターの数字で、あなたには分かりません。必ず null。
    0にしないでください。0は「タダ」の意味になります。
    null なら「単価待ち」として空けたまま先へ進めます（相場は入っているので比べる材料は残ります）。
  qty・unit はアプリが入れる欄です。必ず null のままにしてください。
  分からないものは④の質問に回してください。
  肉厚が分からないと単価が引けません。分からないときは④で聞いてください。

- 移動が要る仕事のときだけ kind:'移動' の項目を入れてください（人数と時間だけ。距離は現場が入れます）。
  工場で作るだけで現場に出ないなら、移動は入れないでください。
- 項目名は見積書にそのまま出ます。職人と元請けの両方が読んで分かる言葉にしてください。
- 質問は多くて3つまで。答えなくても先へ進めるものにしてください。`;
}

// ============================================================
// 職種の呼び方は、アプリから受け取る
//
// よつばの単価は「職種名 → 円/工数」の表を引いて出す（js/rough-calc.js tradeRate）。
// AIが表に無い名前を返すと、その場で単価が引けず、よつばの単価が黙って消える。
// だから聞くときに、表にある名前をそのまま渡す。
//
// 【受付が自分で Firestore を読む形にしなかった理由】2026/8/8
// 一度そう書いて上げたら PERMISSION_DENIED になった。受付のサービスアカウントに
// Firestore の読み取り権限が無い。権限を足すより、表を持っているアプリから
// 渡すほうが早くて確か。渡すのは名前だけで、社内の単価そのものは渡さない。
//
// 古いアプリ（この欄を送らない版）から呼ばれることもあるので、既定を用意しておく。
// ============================================================
const FALLBACK_TRADES = ['現場工事', '整備', '溶接加工', '塗装'];

// 材料の種類も同じ考え方で、アプリ（＝単価マスターを持っている側）から受け取る。
// 出どころは js/catalog.js の CATALOG_KINDS のうち、マスターに実在するものだけ
const FALLBACK_MAT_KINDS = ['配管（SGP）', 'ステンレス配管（TP-A）', 'アングル（山形鋼）', '平鋼（フラットバー）'];

function names(sent, fallback) {
  const list = (Array.isArray(sent) ? sent : [])
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s && s.length <= 30)
    .slice(0, 30);
  return list.length ? list : fallback;
}

const tradeNames = (sent) => names(sent, FALLBACK_TRADES);
const matKindNames = (sent) => names(sent, FALLBACK_MAT_KINDS);

// ============================================================
// 両方そろっているか（よつばの単価 と 相場）
//
// 判定は js/rough-calc.js の yotsubaBase / marketAmount と同じにすること。
// ここがずれると「受付は そろっている と言うのに画面では なし」になる。
// ============================================================
const num = (v) => typeof v === 'number' && isFinite(v);

function hasYotsuba(it, trades) {
  switch (it.kind) {
    case '労務': return num(it.persons) && num(it.hours) && trades.includes(it.trade);
    case '移動': return num(it.persons) && num(it.hours);
    case '材料': return num(it.qty) && num(it.cost);
    default: return false;     // 外注は相手の見積が来るまで金額が無い
  }
}

const hasMarket = (it) => num(it.marketAmount);

// 【「両方そろって当たり前」なのは労務と移動だけ】
// 材料と外注のよつば側は 仕入れ値・外注先の見積 で、AIには分からない。
// そこは埋めさせずに「単価待ち」で空けたまま先へ進める（芯2）。相場は入るので比べる材料は残る。
const needsBoth = (it) => it.kind === '労務' || it.kind === '移動';

// ---------- 埋め直し（片方しか返ってこなかったとき） ----------
// 聞き方をどれだけ強く書いても、返さない回は必ず出る（8/7 の相場がそうだった）。
// 文章の直しだけに頼らず、返ってきたものを見て、欠けていたら1回だけ聞き直す。
// 写真は送らない（項目はもう出ているので要らない）。安く・速く済む。
const FIX = {
  type: 'object',
  additionalProperties: false,
  required: ['index', 'trade', 'persons', 'hours', 'marketAmount'],
  properties: {
    index: { type: 'number', description: '渡した一覧の番号。そのまま返す' },
    trade: { type: ['string', 'null'], description: '職種。渡した一覧から選ぶ' },
    persons: { type: ['number', 'null'], description: '人数' },
    hours: { type: ['number', 'null'], description: '時間' },
    marketAmount: { type: ['number', 'null'], description: '世の中の相場（税抜・売値）' },
  },
};

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fixes'],
  properties: { fixes: { type: 'array', items: FIX } },
};

function fixPrompt(trades) {
  return `さきほど出した概算見積の項目のうち、欄が空いているものだけを渡します。
空いている欄を埋めてください。渡した番号（index）はそのまま返してください。

・trade / persons / hours … 労務と移動に入れます。
  職種は次の中から選んでください: ${trades.join('・')}
  一覧に無い呼び方だと、アプリが単価表を引けず金額が出ません。
・marketAmount … 世の中の相場（税抜・売値）。どの費目にも入れます。

現場はこの2つ（よつばの単価 と 相場）を並べて見比べます。片方しか無いと使えません。
写真が無くても、その工種・その規模で普通どれだけかかるか・いくらかを入れてください。

qty（数量）と cost（よつばの仕入れ値）は聞いていません。空けたままで正しい欄です。
本当に見当が付かないものだけ null にしてください。`;
}

// 欠けている項目だけを聞き直して、欠けていた欄にだけ書き入れる。
// 【入っている値は上書きしない】1回目の答えが正。ここは穴を塞ぐだけの役目。
async function fillGaps(anthropic, items, trades) {
  const gaps = items
    .map((it, index) => ({ it, index }))
    .filter(({ it }) => !hasMarket(it) || (needsBoth(it) && !hasYotsuba(it, trades)));
  if (!gaps.length) return { asked: 0, filled: 0 };

  const ask = gaps.map(({ it, index }) => ({
    index,
    kind: it.kind,
    name: it.name,
    足りない欄: [
      needsBoth(it) && !hasYotsuba(it, trades) ? 'trade・persons・hours' : null,
      !hasMarket(it) ? 'marketAmount' : null,
    ].filter(Boolean).join(' と '),
    いま入っているもの: { trade: it.trade ?? null, persons: it.persons ?? null, hours: it.hours ?? null },
  }));

  let text;
  try {
    const res = await anthropic.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system: fixPrompt(trades),
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: FIX_SCHEMA } },
      messages: [{ role: 'user', content: JSON.stringify(ask, null, 1) }],
    }).finalMessage();
    text = (res.content || []).find((b) => b.type === 'text')?.text;
  } catch (e) {
    // 【ここで止めない】1回目の項目はもう出ている。埋まらなかったぶんは
    // 「片方だけ」として画面に出る（芯2・芯4）。黙って消えるより見えている方がよい。
    logger.warn('埋め直しに失敗しました。片方だけのまま返します', e);
    return { asked: gaps.length, filled: 0, why: String(e && e.message || e) };
  }
  if (!text) return { asked: gaps.length, filled: 0, why: '返事が空' };

  let fixes;
  try { fixes = JSON.parse(text).fixes || []; }
  catch (e) { return { asked: gaps.length, filled: 0, why: 'JSONではなかった' }; }

  let filled = 0;
  for (const f of fixes) {
    const it = items[f.index];
    if (!it) continue;
    let touched = false;
    // 空いている欄だけ。入っている値は触らない
    if (needsBoth(it)) {
      if (!it.trade && typeof f.trade === 'string' && trades.includes(f.trade)) { it.trade = f.trade; touched = true; }
      if (!num(it.persons) && num(f.persons)) { it.persons = f.persons; touched = true; }
      if (!num(it.hours) && num(f.hours)) { it.hours = f.hours; touched = true; }
    }
    if (!hasMarket(it) && num(f.marketAmount)) { it.marketAmount = f.marketAmount; touched = true; }
    if (touched) filled += 1;
  }
  return { asked: gaps.length, filled };
}

// 画面と記録に出す「そろい具合」。数字と、足りない項目の名前（多くて3つ）
function coverageOf(items, trades) {
  const missingYotsuba = items.filter((it) => needsBoth(it) && !hasYotsuba(it, trades));
  const missingMarket = items.filter((it) => !hasMarket(it));
  return {
    items: items.length,
    needBoth: items.filter(needsBoth).length,
    withYotsuba: items.filter((it) => hasYotsuba(it, trades)).length,
    withMarket: items.filter(hasMarket).length,
    missingYotsuba: missingYotsuba.length,
    missingMarket: missingMarket.length,
    missingYotsubaNames: missingYotsuba.slice(0, 3).map((it) => it.name || '（名前なし）'),
    missingMarketNames: missingMarket.slice(0, 3).map((it) => it.name || '（名前なし）'),
  };
}

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
    // 【App Check を通っていない呼び出しは、ここで弾く】
    // この入口はインターネットの誰からでも届く。匿名ログインだけでは、
    // 公開されている apiKey を見た誰でも通れてしまい、AIの料金を焼かれる。
    // 弾かれた側（アプリ）は画面がひな形に戻すので、現場の手は止まらない。
    enforceAppCheck: true,
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

    // 職種の呼び方と材料の種類（アプリの単価表にある名前をそのまま聞く。無ければ既定）
    const trades = tradeNames(request.data?.trades);
    const matKinds = matKindNames(request.data?.matKinds);

    // ---------- 写真を集める ----------
    const blocks = [];
    let total = 0;
    const bucket = admin.storage().bucket();
    const read = [];      // 実際に読めた写真
    const skipped = [];   // 飛ばした写真と、その理由

    for (const path of (Array.isArray(photoPaths) ? photoPaths : []).slice(0, MAX_PHOTOS)) {
      // 【必ず確かめる】概算の写真置き場の中だけ。
      // ここを見ないと、呼んだ人がバケット内の好きなファイルを読ませられてしまう。
      if (typeof path !== 'string' || !path.startsWith(PHOTO_PREFIX) || path.includes('..')) {
        throw new HttpsError('invalid-argument', '写真の置き場所が不正です');
      }
      const file = bucket.file(path);
      let meta = null;
      try {
        [meta] = await file.getMetadata();
      } catch (e) {
        // 【黙って飛ばさない】読めなかった理由を必ず残す。
        // ここを握りつぶすと「写真を渡したのに読まれない」が原因不明のまま残る。
        skipped.push({ path, why: '見に行けなかった', detail: String(e && e.message || e) });
        continue;
      }

      const size = Number(meta.size) || 0;
      if (total + size > MAX_TOTAL_BYTES) {
        skipped.push({ path, why: '合計サイズの上限を超えた', size, total });
        break;
      }
      total += size;

      const mime = meta.contentType || '';
      if (mime !== 'application/pdf' && !/^image\/(jpeg|png|gif|webp)$/.test(mime)) {
        // iPad は写真を HEIC で上げてくることがある。ここに落ちると1枚も読めない
        skipped.push({ path, why: '扱えない形式', mime, size });
        continue;
      }

      const [buf] = await file.download();
      const data = buf.toString('base64');
      read.push({ path, mime, size });

      if (mime === 'application/pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
      } else {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data } });
      }
    }

    blocks.push({
      type: 'text',
      text: [
        `工事の種類: ${workType}`,
        `すること: ${oneLiner || '（一言なし。写真から読み取ってください）'}`,
        blocks.length ? '' : '※写真がありません。工事の種類とすることだけで出してください。',
      ].filter(Boolean).join('\n'),
    });

    // 【何を送ったかを必ず残す】
    // 「写真を渡したのに読まれない」を推測で追わないための記録。
    logger.info('AIに送る中身', {
      bucket: bucket.name,
      pathsReceived: Array.isArray(photoPaths) ? photoPaths : [],
      readCount: read.length,
      read,
      skipped,
      promptText: blocks[blocks.length - 1].text,
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
        system: systemPrompt(trades, matKinds),
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

    // 【何が返ったかを必ず残す】返事の頭を生のまま置く
    logger.info('AIの返事（生）', {
      stop_reason: res.stop_reason,
      usage: res.usage,
      head: text.slice(0, 4000),
    });

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
      // よつばの仕入れ値はAIには分からない。返してきても捨てる。
      // 作り話の数字が「よつばの単価」の顔をして合計候補に出るのがいちばん悪い
      cost: null,
      // 本数と単位はアプリが単価マスターの定尺から出す（js/rough-material.js）。
      // AIが「15本」と書いてきても、定尺を知らずに割った本数なので使わない
      qty: null,
      unit: null,
      state: '未確定',
      source: 'ai',
      order: i,
    }));

    // ---------- 両方そろっているか ----------
    // よつばの単価と相場は2つで1組。片方だけでは現場が比べられない。
    // 欠けていたら1回だけ聞き直し（写真は送らない）、それでも欠けたぶんは数で返して画面に出す。
    const before = coverageOf(items, trades);
    const fix = await fillGaps(anthropic, items, trades);
    const coverage = { ...coverageOf(items, trades), asked: fix.asked, filled: fix.filled };

    if (coverage.missingYotsuba || coverage.missingMarket) {
      // 【黙って片方だけ返さない】8/7 は相場が、8/8 はよつばの単価が黙って消えた。
      // どちらも「返ってきたものを見ていなかった」から気づけなかった。ここで必ず残す。
      logger.warn('片方だけの項目が残りました', { workType, before, after: coverage, why: fix.why });
    }

    logger.info('項目を出しました', {
      workType,
      photos: blocks.length - 1,
      items: items.length,
      questions: (parsed.questions || []).length,
      trades,
      coverage,
      usage: res.usage,
    });

    // 読めた枚数と、飛ばした枚数を必ず返す。
    // 「写真を渡したのに読まれていない」を、画面側が出せるようにするため（芯4）。
    return {
      items,
      questions: parsed.questions || [],
      photosRead: read.length,
      photosSkipped: skipped.length,
      coverage,
    };
  },
);
