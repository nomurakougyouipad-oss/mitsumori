// ============================================================
// Service Worker — アプリシェルのオフラインキャッシュ（PWA）
// ・自サイトの静的ファイルのみキャッシュ
// ・Firebase/フォント等のクロスオリジンは常にネットワーク
// （zaiko-shohin から流用）
// ============================================================

const VERSION = 'v25';
const CACHE = 'mitsumori-' + VERSION;

// アプリシェル（オフラインでも起動できる最小セット）
// ※ ?v= は index.html と 各jsファイルの import の ?v= に一致させること
//   （バージョンを上げるときは VERSION・index.html・js内import・この一覧を全て更新）
const SHELL = [
  './',
  './index.html',
  './app.css?v=21',
  './manifest.webmanifest',
  './firebase-config.js?v=21',
  './js/app.js?v=21',
  './js/util.js?v=21',
  './js/icons.js?v=21',
  './js/firebase.js?v=21',
  './js/calc.js?v=21',
  './js/store.js?v=21',
  './js/ui.js?v=21',
  './js/screen-home.js?v=21',
  './js/screen-est.js?v=21',
  './js/screen-material.js?v=21',
  './js/catalog.js?v=21',
  './js/jis-sizes.js?v=21',
  './js/screen-order.js?v=21',
  './js/screen-settings.js?v=21',
  './js/screen-tally.js?v=21',
  './js/export.js?v=21',
  './icons/icon-48.png',
  './icons/icon-120.png',
  './icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 自オリジン以外（Firebase, Google Fonts 等）はネットワーク優先で素通し
  if (url.origin !== self.location.origin) return;

  // ページ遷移（ナビゲーション）: キャッシュ優先で即起動し、
  // 背後で最新の index.html を取得して次回起動に反映する
  // （PWA起動時にネットワーク待ちの白画面を出さないため）
  // ※アプリ本体（ルート）への遷移だけが対象。tools/ 等のサブページを
  //   index.html で乗っ取らないよう、パスを必ず確認する
  const isAppRoot = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
  if (req.mode === 'navigate' && !isAppRoot) return;
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then((cached) => {
        const network = fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./index.html', copy));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // 静的アセット: キャッシュ優先 + 背後で更新（stale-while-revalidate）
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
