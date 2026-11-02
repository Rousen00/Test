// Офлайн-кэш: оболочка приложения и библиотеки с CDN. API никогда не кэшируется.
const VERSION = "hm-v1";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];
const CDN = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try { const res = await fetch(req); if (res.ok) cache.put(req, res.clone()); return res; }
  catch (e) { return (await cache.match(req)) || (await cache.match("index.html")) || Response.error(); }
}
async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  const net = fetch(req).then(res => { if (res.ok || res.type === "opaque") cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || net;
}

self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.includes("/api/")) return;
    if (req.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname.endsWith("/")) return e.respondWith(networkFirst(req));
    return e.respondWith(staleWhileRevalidate(req));
  }
  if (CDN.includes(url.hostname)) e.respondWith(staleWhileRevalidate(req));
});
