// Service Worker der Türampel-App.
// Hält die App-Dateien für einen schnellen Start bereit und öffnet die App
// beim Tipp auf eine Benachrichtigung. Push-Mitteilungen kommen mit M6.

const CACHE = "tuerampel-v1";
const DATEIEN = [
  "/",
  "/app.js",
  "/app.css",
  "/manifest.webmanifest",
  "/fonts/space-grotesk-700.woff2",
  "/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(DATEIEN)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

// Zuerst das Netz, damit nach einem Deploy sofort die neue App läuft.
// Nur ohne Netz kommt die zwischengespeicherte Fassung.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/ws/") || url.pathname.startsWith("/test") || url.pathname === "/health") return;

  event.respondWith(
    (async () => {
      try {
        const antwort = await fetch(event.request);
        if (antwort.ok && DATEIEN.includes(url.pathname)) {
          const cache = await caches.open(CACHE);
          await cache.put(event.request, antwort.clone());
        }
        return antwort;
      } catch (fehler) {
        const gespeichert = await caches.match(event.request);
        if (gespeichert) return gespeichert;
        throw fehler;
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const fenster = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const f of fenster) {
        if ("focus" in f) return f.focus();
      }
      return self.clients.openWindow("/");
    })(),
  );
});
