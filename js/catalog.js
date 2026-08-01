// ============================================================
// 標準品カタログ — 種類 → 材質 → 寸法 の順に選ばせて品名を決める
//
// なぜ選択式か: 手打ちだと人によって書き方が割れ、単価マスターに
// 同じ物が別名で溜まる。選択式なら書き方が1つに決まる。
//
// 品名の書き方は「推測しない」。単価マスター1,567件の実データから組み立てる。
//  ・種類×材質ごとに書き方が違う（実データで確認した例）
//      ｱﾝｸﾞﾙ(SS400)  L-6x65x65x6000     … L- が付く
//      ｱﾝｸﾞﾙ(SUS304) 6x50x50x4000       … 付かないものもある
//      平鋼(SS400)   FB-6x65x6000       ／ 平鋼(SUS304) 3x50x4000
//      丸棒(SS400)   RB-φ16x6000        ／ 丸棒(SUS304) 8φx4000
//      角ﾊﾟｲﾌﾟ(STKR400) □-2.3x50x50x6000 ／ 角ﾊﾟｲﾌﾟ(SUS304) 1.5x40x40x6000
//  ・そこで、マスターにあるサイズは「保存されている品名をそのまま使う」。
//    一覧に無いサイズだけ、その種類×材質で一番多い書き方（型）に数字を入れて作る。
//
// 単価はカタログからは入れない（README/②）。マスターに同じ品名があればその単価を使い、
// 無ければ単価待ち（時計マーク）にして事務所が業者に聞いて入れる。
// ============================================================

import { norm } from './store.js?v=20';

// 画面に出す種類。heads はマスターの品名の先頭語（実データの表記に合わせる）
export const CATALOG_KINDS = [
  { key: 'angle', label: 'アングル（山形鋼）', heads: ['ｱﾝｸﾞﾙ'] },
  { key: 'channel', label: '溝形鋼（チャンネル）', heads: ['溝形鋼'] },
  { key: 'fb', label: '平鋼（フラットバー）', heads: ['平鋼', 'FBH'] },
  { key: 'hbeam', label: 'H形鋼', heads: ['H形鋼'] },
  { key: 'round', label: '丸棒', heads: ['丸棒'] },
  { key: 'sqpipe', label: '角パイプ', heads: ['角ﾊﾟｲﾌﾟ', '正方形角ﾊﾟｲﾌﾟ', '長方形角ﾊﾟｲﾌﾟ'] },
  { key: 'pipe', label: '丸パイプ', heads: ['丸ﾊﾟｲﾌﾟ'] },
  { key: 'plate', label: '平板', heads: ['平板'] },
  { key: 'checker', label: '縞板（チェッカープレート）', heads: ['ﾁｪｯｶｰﾌﾟﾚｰﾄ'] },
  { key: 'sgp', label: '配管（SGP）', heads: ['SGP'] },
  { key: 'tpa', label: 'ステンレス配管（TP-A）', heads: ['TP-A'] },
];

// 寸法の各桁が何を指すか。分かるものだけ入れる（分からないものは位置で示す）
const SLOT_LABELS = {
  'ｱﾝｸﾞﾙ': ['板厚', '辺A', '辺B', '長さ'],
  '平鋼': ['板厚', '幅', '長さ'],
  'FBH': ['板厚', '幅', '長さ'],
  'H形鋼': ['高さ', '幅', 'ウェブ厚', 'フランジ厚', '長さ'],
  '丸棒': ['径', '長さ'],
  '角ﾊﾟｲﾌﾟ': ['板厚', '辺A', '辺B', '長さ'],
  '正方形角ﾊﾟｲﾌﾟ': ['板厚', '辺A', '辺B', '長さ'],
  '長方形角ﾊﾟｲﾌﾟ': ['板厚', '辺A', '辺B', '長さ'],
  '平板': ['板厚', '幅', '長さ'],
  'ﾁｪｯｶｰﾌﾟﾚｰﾄ': ['板厚', '幅', '長さ'],
  'SGP': ['呼び径A', '長さm'],
};

// 品名を「先頭語・（修飾）・（材質）・寸法」に割る。
// 最初の空白までが 先頭語＋かっこ、その後ろが寸法。
// 例 平鋼(FB-C)(SUS304) 5x40xL=500 → head=平鋼 mods=[FB-C] material=SUS304 dims=5x40xL=500
export function parseItemName(name) {
  const nm = String(name || '');
  const sp = nm.indexOf(' ');
  const left = sp < 0 ? nm : nm.slice(0, sp);
  const dims = sp < 0 ? '' : nm.slice(sp + 1).trim();
  const head = (/^([^(（]*)/.exec(left) || ['', ''])[1];
  const parens = [...left.matchAll(/[(（]([^)）]*)[)）]/g)].map((x) => x[1]);
  return { head, mods: parens.slice(0, -1), material: parens[parens.length - 1] || '', dims };
}

// 寸法から「型」を作る（数字を {} に置き換える）。6x65x65x6000 → {}x{}x{}x{}
export const dimPattern = (dims) => String(dims || '').replace(/\d+(?:\.\d+)?/g, '{}');
const slotCount = (p) => (p.match(/\{\}/g) || []).length;

// その種類×材質で一番多い書き方を選ぶ。
// 同数なら桁数の多いほう（L-付き等、より具体的なほう）を採る
function dominantPattern(dimsList) {
  const cnt = {};
  for (const d of dimsList) { const p = dimPattern(d); cnt[p] = (cnt[p] || 0) + 1; }
  const sorted = Object.entries(cnt).sort((a, b) =>
    b[1] - a[1] || slotCount(b[0]) - slotCount(a[0]) || b[0].length - a[0].length);
  return sorted.length ? sorted[0][0] : '';
}

// 一番多い単位（本・枚など）
function dominantUnit(items) {
  const cnt = {};
  for (const it of items) { const u = it.unit || ''; if (u) cnt[u] = (cnt[u] || 0) + 1; }
  const sorted = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
  return sorted.length ? sorted[0][0] : '本';
}

// 型に数字を入れて寸法文字列にする。{} を順に置き換える
export function fillPattern(pattern, values) {
  let i = 0;
  return String(pattern).replace(/\{\}/g, () => {
    const v = values[i++];
    return (v === undefined || v === null || v === '') ? '?' : String(v);
  });
}

// 品名を組み立てる（マスターと同じ書き方）。head(material) dims
export function makeName(head, material, dims) {
  return material ? `${head}(${material}) ${dims}` : `${head} ${dims}`;
}

// ---------- カタログの組み立て ----------
// items（単価マスター）から 種類 → 材質 → サイズ を作る。
// 戻り値の sizes は「マスターに実在するサイズ」。品名は保存されているものをそのまま使う。
export function buildCatalog(items) {
  const byKind = {};
  for (const def of CATALOG_KINDS) byKind[def.key] = { def, materials: {} };

  for (const it of items) {
    const p = parseItemName(it.name);
    const def = CATALOG_KINDS.find((d) => d.heads.includes(p.head));
    if (!def) continue;
    if (!p.dims) continue;                        // 寸法が無いものは対象外
    const mats = byKind[def.key].materials;
    const key = p.material || '（材質なし）';
    if (!mats[key]) mats[key] = { material: p.material, heads: {}, sizes: [] };
    mats[key].heads[p.head] = (mats[key].heads[p.head] || 0) + 1;
    mats[key].sizes.push({
      id: it.id, name: it.name, head: p.head, mods: p.mods,
      dims: p.dims, cost: it.cost, unit: it.unit || '', supplier: it.supplier || '',
    });
  }

  // 種類×材質ごとに「一番多い書き方」と「桁の見出し」を決める
  for (const k of Object.keys(byKind)) {
    const mats = byKind[k].materials;
    for (const m of Object.keys(mats)) {
      const g = mats[m];
      g.sizes.sort((a, b) => a.dims.localeCompare(b.dims, 'ja', { numeric: true }));
      // 先頭語が複数ある場合（角ﾊﾟｲﾌﾟ/正方形角ﾊﾟｲﾌﾟ等）は多いほうを代表にする
      g.head = Object.entries(g.heads).sort((a, b) => b[1] - a[1])[0][0];
      g.pattern = dominantPattern(g.sizes.filter((s) => s.head === g.head).map((s) => s.dims));
      g.unit = dominantUnit(g.sizes);
      g.labels = SLOT_LABELS[g.head] || [];
      // 各桁に「これまで使われた数字」を集める（新しいサイズを組むときの候補）
      g.slotValues = [];
      const n = slotCount(g.pattern);
      for (let i = 0; i < n; i++) g.slotValues.push(new Set());
      for (const s of g.sizes) {
        if (dimPattern(s.dims) !== g.pattern) continue;
        const nums = s.dims.match(/\d+(?:\.\d+)?/g) || [];
        nums.forEach((v, i) => { if (g.slotValues[i]) g.slotValues[i].add(v); });
      }
      g.slotValues = g.slotValues.map((set) => [...set].sort((a, b) => parseFloat(a) - parseFloat(b)));
      // 組み立ての初期値。必ず「型と桁数が合う」実在サイズから採る
      //（3桁しかない例外行を種にすると桁がずれるため）
      const seed = g.sizes.find((s) => dimPattern(s.dims) === g.pattern);
      g.seedValues = seed ? (seed.dims.match(/\d+(?:\.\d+)?/g) || []).slice(0, n) : new Array(n).fill('');
    }
  }
  return byKind;
}

// 種類の一覧（マスターに1件でもあるものだけ出す）
export function catalogKinds(cat) {
  return CATALOG_KINDS
    .map((d) => ({ ...d, count: Object.values(cat[d.key].materials).reduce((a, g) => a + g.sizes.length, 0) }))
    .filter((d) => d.count > 0);
}

// 材質の一覧（件数の多い順）
export function catalogMaterials(cat, kindKey) {
  const mats = cat[kindKey] ? cat[kindKey].materials : {};
  return Object.entries(mats)
    .map(([label, g]) => ({ label, ...g }))
    .sort((a, b) => b.sizes.length - a.sizes.length);
}

// 組み立てた品名が既にマスターにあるか探す（表記ゆれを吸収して照合）
export function findItemByName(items, name) {
  const key = norm(name);
  return items.find((it) => norm(it.name) === key) || null;
}
