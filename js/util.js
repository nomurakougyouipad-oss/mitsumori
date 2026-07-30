// ============================================================
// 共通ユーティリティ — 金額・日付・エスケープ・端末記憶・CSV
// （zaiko-shohin から流用・見積アプリ用に調整）
// ============================================================

export const NAVY = '#1B3A5C';
export const ACCENT = '#BA7517';
export const RED = '#b3261e';

export function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

// 金額表示（UI設計に合わせて全角￥）
export const YEN = (n) => '￥' + Math.round(num(n)).toLocaleString('ja-JP');

// Firestore Timestamp / Date / null → Date か null
export function toDate(v) {
  if (!v) return null;
  if (v.toDate) return v.toDate();
  if (v instanceof Date) return v;
  return null;
}

const p2 = (n) => String(n).padStart(2, '0');

export function fmtDate(v) {
  const d = toDate(v);
  if (!d) return '—';
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
}

export function fmtDateJa(v) {
  const d = toDate(v);
  if (!d) return '—';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function fmtDateTime(v) {
  const d = toDate(v);
  if (!d) return '—';
  return `${fmtDate(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// HTMLエスケープ（ユーザー入力の描画は必ずこれを通す）
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// CSV出力（UTF-8 BOM付き）
// iPhone/iPad は共有シート（ファイルに保存・メール等）で渡す。
// ホーム画面起動（PWA）では <a download> の Blob 保存が正常に動かず、
// 実行後に画面のタップが効かなくなる不具合があるため。
export function downloadCsv(filename, rows) {
  const cell = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOSはMac名義
  if (isIOS && navigator.canShare) {
    const file = new File([blob], filename, { type: 'text/csv' });
    if (navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file] }).catch(() => { /* キャンセルは無視 */ });
      return;
    }
  }

  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // 即時に revoke するとダウンロード開始前にURLが無効になる端末があるため遅らせる
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

// 端末側の記憶（担当者・前回選択など）
export const local = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem('mitsumori:' + key); return v == null ? fallback : v; }
    catch (_) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('mitsumori:' + key, value); } catch (_) { /* 無視 */ }
  },
};
