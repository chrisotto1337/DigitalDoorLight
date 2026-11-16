import { ROLLEN_HEADER } from "./door";
import type { Env } from "./env";
import type { Rolle } from "./protocol";
import { TESTSEITE_HTML, TESTSEITE_JS } from "./testseite";

export { Door } from "./door";

// Name des einen Durable Objects, das die Tuer verwaltet.
const TUER = "tuer";

// Liegt in public/, wird aber nur mit Display-Schluessel ausgeliefert (run_worker_first).
const FIRMWARE_PFAD = "/firmware/tuerampel.bin";

function antwort(text: string, status = 200, typ = "text/plain; charset=utf-8"): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": typ,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// Vergleicht zwei Schluessel in konstanter Zeit, unabhaengig von ihrer Laenge.
async function gleicherSchluessel(gegeben: string, erwartet: string): Promise<boolean> {
  const kodierer = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", kodierer.encode(gegeben)),
    crypto.subtle.digest("SHA-256", kodierer.encode(erwartet)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// null: Schluessel stimmt. Sonst die Antwort mit dem Fehler.
async function schluesselPruefen(request: Request, env: Env, rolle: Rolle): Promise<Response | null> {
  const erwartet = rolle === "display" ? env.DEVICE_KEY : env.APP_KEY;
  if (!erwartet) {
    const name = rolle === "display" ? "DEVICE_KEY" : "APP_KEY";
    return antwort(`${name} ist auf dem Server nicht gesetzt`, 500);
  }
  const gegeben = new URL(request.url).searchParams.get("key") ?? "";
  if (!(await gleicherSchluessel(gegeben, erwartet))) {
    return antwort("Nicht berechtigt", 401);
  }
  return null;
}

async function verbinden(request: Request, env: Env, rolle: Rolle): Promise<Response> {
  const fehler = await schluesselPruefen(request, env, rolle);
  if (fehler) {
    return fehler;
  }

  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return antwort("WebSocket erwartet", 426);
  }

  const kopf = new Headers(request.headers);
  kopf.set(ROLLEN_HEADER, rolle);
  const tuer = env.DOOR.get(env.DOOR.idFromName(TUER));
  return tuer.fetch(new Request(request, { headers: kopf }));
}

// Firmware fuer das Update ueber WLAN. Der MD5-Kopf laesst das Display pruefen,
// dass die Datei vollstaendig angekommen ist.
async function firmware(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return antwort("Nur GET", 405);
  }
  const fehler = await schluesselPruefen(request, env, "display");
  if (fehler) {
    return fehler;
  }
  const datei = await env.ASSETS.fetch(new URL(FIRMWARE_PFAD, request.url));
  if (!datei.ok) {
    return antwort("Keine Firmware hinterlegt", 404);
  }
  // Ganz lesen, damit Content-Length sicher gesetzt ist: das Update braucht die Groesse vorab.
  const inhalt = await datei.arrayBuffer();
  const kopf = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": String(inhalt.byteLength),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (env.FIRMWARE_MD5) {
    kopf.set("x-MD5", env.FIRMWARE_MD5);
  }
  if (env.FIRMWARE_VERSION) {
    kopf.set("x-Firmware-Version", env.FIRMWARE_VERSION);
  }
  return new Response(inhalt, { headers: kopf });
}

// Die App selbst (/, /app.js, ...) liefert Cloudflare direkt aus public/ aus.
// Dieser Worker bekommt nur Anfragen, zu denen es dort keine Datei gibt,
// und alles unter /firmware/.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/health":
        return antwort(JSON.stringify({ ok: true }), 200, "application/json");

      case "/ws/display":
        return verbinden(request, env, "display");

      case "/ws/app":
        return verbinden(request, env, "app");

      case FIRMWARE_PFAD:
        return firmware(request, env);

      case "/test": {
        const seite = antwort(TESTSEITE_HTML, 200, "text/html; charset=utf-8");
        seite.headers.set(
          "Content-Security-Policy",
          `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; ` +
            `connect-src 'self' wss://${url.host} ws://${url.host}; ` +
            `base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        );
        seite.headers.set("Referrer-Policy", "no-referrer");
        return seite;
      }

      case "/test.js":
        return antwort(TESTSEITE_JS, 200, "text/javascript; charset=utf-8");

      default:
        // Andere Dateien unter /firmware/ gibt es nicht nach aussen.
        return antwort("Nicht gefunden", 404);
    }
  },
} satisfies ExportedHandler<Env>;
