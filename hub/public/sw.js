// Service Worker der Türampel-App.
// Hält die App-Dateien für einen schnellen Start bereit, zeigt Push-Mitteilungen
// und öffnet die App beim Tipp auf eine Mitteilung.

const CACHE = "tuerampel-v2";
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

// ---------- Push ----------

function uhrzeit(ms) {
  return new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

async function mitteilungZeigen(d) {
  // Ist die App gerade vorn, klingelt sie selbst. Die Mitteilung kommt trotzdem,
  // Safari entzieht sonst die Erlaubnis.
  const fenster = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const imBlick = fenster.some((f) => f.visibilityState === "visible" && f.focused);
  const basis = { icon: "/icons/icon-192.png", lang: "de", data: d, silent: imBlick };

  switch (d.art) {
    case "anfrage":
      try {
        await self.navigator.setAppBadge?.(1);
      } catch {
        // Nicht jeder Browser kennt Zahlen am App-Symbol
      }
      return self.registration.showNotification("Anfrage an der Tür", {
        ...basis,
        body: "Jemand möchte rein. Tippen zum Antworten.",
        tag: "anfrage",
        renotify: true,
        requireInteraction: true,
      });

    case "verpasst":
      // Ersetzt die Anfrage still. Kam die gar nicht an, meldet sie sich normal.
      return self.registration.showNotification("Verpasste Anfrage", {
        ...basis,
        body: typeof d.start === "number" ? `Um ${uhrzeit(d.start)} wollte jemand rein.` : "Jemand wollte rein.",
        tag: "anfrage",
        renotify: false,
      });

    case "test":
      return self.registration.showNotification("Türampel", {
        ...basis,
        silent: false,
        body: "Test-Mitteilung. So kommt eine Anfrage an.",
        tag: "test",
      });

    default:
      return self.registration.showNotification("Türampel", { ...basis, body: "Neues von der Tür", tag: "sonstiges" });
  }
}

self.addEventListener("push", (event) => {
  let daten = {};
  try {
    daten = event.data ? event.data.json() : {};
  } catch {
    daten = {};
  }
  event.waitUntil(mitteilungZeigen(daten));
});

// Der Browser hat das Abo erneuert. Der Hub erfährt es, sobald die App das nächste Mal verbindet.
self.addEventListener("pushsubscriptionchange", (event) => {
  const optionen = event.oldSubscription?.options;
  if (!optionen) return;
  event.waitUntil(self.registration.pushManager.subscribe(optionen).catch(() => {}));
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
