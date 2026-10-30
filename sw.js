/* QUIZFORCE HQ PWA: NO caching of private pages, sessions or API responses.
   The installed app requires an internet connection for login and statistics. */
const CACHE_PREFIX = 'quizforce-hq-pwa-';
self.addEventListener('install', event => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX)).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.mode !== 'navigate' || request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(request).catch(() => new Response(
    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#080e23"><title>QUIZFORCE HQ — Offline</title><body style="font:18px system-ui;background:#080e23;color:#fff;text-align:center;padding:20vh 20px"><h1>⚡ HQ is offline</h1><p>Reconnect to the internet to log in and see live statistics.</p></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  )));
});
