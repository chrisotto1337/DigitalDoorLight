import { ROLLEN_HEADER } from "./door";
import type { Env } from "./env";
import type { Rolle } from "./protocol";
import { TESTSEITE_HTML, TESTSEITE_JS } from "./testseite";

export { Door } from "./door";

// Name des einen Durable Objects, das die Tuer verwaltet.
const TUER = "tuer";

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

async function verbinden(request: Request, env: Env, rolle: Rolle): Promise<Response> {
  const erwartet = rolle === "display" ? env.DEVICE_KEY : env.APP_KEY;
  if (!erwartet) {
    const name = rolle === "display" ? "DEVICE_KEY" : "APP_KEY";
    return antwort(`${name} ist auf dem Server nicht gesetzt`, 500);
  }

  const gegeben = new URL(request.url).searchParams.get("key") ?? "";
  if (!(await gleicherSchluessel(gegeben, erwartet))) {
    return antwort("Nicht berechtigt", 401);
  }

  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return antwort("WebSocket erwartet", 426);
  }

  const kopf = new Headers(request.headers);
  kopf.set(ROLLEN_HEADER, rolle);
  const tuer = env.DOOR.get(env.DOOR.idFromName(TUER));
  return tuer.fetch(new Request(request, { headers: kopf }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/":
        return antwort("Tuerampel-Hub laeuft. Testseite: /test\n");

      case "/health":
        return antwort(JSON.stringify({ ok: true }), 200, "application/json");

      case "/ws/display":
        return verbinden(request, env, "display");

      case "/ws/app":
        return verbinden(request, env, "app");

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
        return antwort("Nicht gefunden", 404);
    }
  },
} satisfies ExportedHandler<Env>;
