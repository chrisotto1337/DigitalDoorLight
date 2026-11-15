// Ablauftest fuer den Hub: startet "wrangler dev" und spielt Display und App durch.
// Aufruf: npm test   (braucht Node 22 oder neuer)

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const PORT = 8799;
const BASIS = `http://127.0.0.1:${PORT}`;
const WS_BASIS = `ws://127.0.0.1:${PORT}`;
const DISPLAY_KEY = "test-display-schluessel";
const APP_KEY = "test-app-schluessel";
const FRIST_S = 2;

const speicher = mkdtempSync(join(tmpdir(), "tuerampel-hub-"));
let server = null;

// ---------- wrangler dev starten und stoppen ----------

async function portFrei() {
  try {
    await fetch(`${BASIS}/health`);
    return false;
  } catch {
    return true;
  }
}

async function serverStarten() {
  if (!(await portFrei())) {
    throw new Error(`Port ${PORT} ist belegt. Laeuft noch ein alter Testserver?`);
  }
  // Eigene Prozessgruppe, damit beim Stoppen auch workerd mit beendet wird.
  server = spawn(
    join(import.meta.dirname, "..", "node_modules", ".bin", "wrangler"),
    [
      "dev",
      "--port", String(PORT),
      "--ip", "127.0.0.1",
      "--persist-to", speicher,
      "--var", `DEVICE_KEY:${DISPLAY_KEY}`,
      "--var", `APP_KEY:${APP_KEY}`,
      "--var", `ANFRAGE_FRIST_S:${FRIST_S}`,
      "--show-interactive-dev-session=false",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  let ausgabe = "";
  server.stdout.on("data", (d) => (ausgabe += d));
  server.stderr.on("data", (d) => (ausgabe += d));

  const ende = Date.now() + 60_000;
  while (Date.now() < ende) {
    if (server.exitCode !== null) {
      throw new Error(`wrangler dev ist beendet:\n${ausgabe}`);
    }
    try {
      const r = await fetch(`${BASIS}/health`);
      if (r.ok) return;
    } catch {
      // noch nicht bereit
    }
    await pause(300);
  }
  throw new Error(`wrangler dev startet nicht:\n${ausgabe}`);
}

function gruppeBeenden(signal) {
  try {
    process.kill(-server.pid, signal);
  } catch {
    // Gruppe gibt es schon nicht mehr
  }
}

async function serverStoppen() {
  if (!server) return;
  if (server.exitCode === null) {
    const beendet = new Promise((ok) => server.once("exit", ok));
    gruppeBeenden("SIGTERM");
    await Promise.race([beendet, pause(10_000)]);
  }
  gruppeBeenden("SIGKILL");
  server = null;
  // Warten, bis der Port wirklich frei ist
  for (let i = 0; i < 50 && !(await portFrei()); i++) {
    await pause(200);
  }
}

function pause(ms) {
  return new Promise((ok) => setTimeout(ok, ms));
}

// ---------- Test-Client ----------

class Client {
  constructor(name) {
    this.name = name;
    this.posteingang = [];
    this.wartende = [];
  }

  verbinden(rolle, schluessel) {
    return new Promise((ok, fehler) => {
      this.ws = new WebSocket(`${WS_BASIS}/ws/${rolle}?key=${encodeURIComponent(schluessel)}`);
      this.ws.onopen = () => ok(this);
      this.ws.onerror = () => fehler(new Error(`${this.name}: Verbindung fehlgeschlagen`));
      this.ws.onmessage = (e) => this.ankommen(String(e.data));
    });
  }

  ankommen(text) {
    const nachricht = text === "pong" ? { typ: "pong" } : JSON.parse(text);
    const index = this.wartende.findIndex((w) => w.passt(nachricht));
    if (index >= 0) {
      const [w] = this.wartende.splice(index, 1);
      clearTimeout(w.timer);
      w.ok(nachricht);
    } else {
      this.posteingang.push(nachricht);
    }
  }

  // Wartet auf die naechste Nachricht des Typs, die die Bedingung erfuellt.
  // Aeltere Nachrichten davor werden verworfen.
  warte(typ, ms = 5000, bedingung = () => true) {
    const passt = (n) => n.typ === typ && bedingung(n);
    const index = this.posteingang.findIndex(passt);
    if (index >= 0) {
      return Promise.resolve(this.posteingang.splice(0, index + 1).pop());
    }
    return new Promise((ok, fehler) => {
      const eintrag = {
        passt,
        ok,
        timer: setTimeout(() => {
          this.wartende.splice(this.wartende.indexOf(eintrag), 1);
          fehler(new Error(`${this.name}: keine Nachricht "${typ}" nach ${ms} ms`));
        }, ms),
      };
      this.wartende.push(eintrag);
    });
  }

  senden(nachricht) {
    this.ws.send(typeof nachricht === "string" ? nachricht : JSON.stringify(nachricht));
  }

  leeren() {
    this.posteingang = [];
  }

  schliessen() {
    return new Promise((ok) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return ok();
      this.ws.onclose = () => ok();
      this.ws.close();
    });
  }
}

// Verbindet und wartet die Begruessung des Hubs ab (status, bei Apps auch geraet),
// damit sie nicht in spaetere Tests hineinlaeuft.
async function client(name, rolle) {
  const c = await new Client(name).verbinden(rolle, rolle === "app" ? APP_KEY : DISPLAY_KEY);
  c.start = { status: await c.warte("status") };
  if (rolle === "app") {
    c.start.geraet = await c.warte("geraet");
  }
  return c;
}

// ---------- Tests ----------

const ergebnisse = [];

async function test(name, ablauf) {
  try {
    await ablauf();
    ergebnisse.push([true, name]);
    console.log(`  ok    ${name}`);
  } catch (e) {
    ergebnisse.push([false, name]);
    console.log(`  FEHLER ${name}\n         ${e.message}`);
  }
}

async function main() {
  console.log("Starte wrangler dev …");
  await serverStarten();
  console.log("Tests:");

  await test("falscher Schluessel wird abgewiesen", async () => {
    const r = await fetch(`${BASIS}/ws/app?key=falsch`);
    assert.equal(r.status, 401);
    const r2 = await fetch(`${BASIS}/ws/display?key=${APP_KEY}`);
    assert.equal(r2.status, 401, "App-Schluessel darf nicht als Display gelten");
  });

  await test("ohne WebSocket gibt es 426", async () => {
    const r = await fetch(`${BASIS}/ws/app?key=${APP_KEY}`);
    assert.equal(r.status, 426);
  });

  await test("Testseite wird ausgeliefert", async () => {
    const r = await fetch(`${BASIS}/test`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Testseite/);
    const js = await fetch(`${BASIS}/test.js`);
    assert.equal(js.status, 200);
  });

  const appA = await client("App A", "app");
  const appB = await client("App B", "app");

  await test("neue Verbindung bekommt Status und Geraet", async () => {
    assert.equal(appA.start.status.farbe, "gruen");
    assert.equal(appA.start.geraet.online, false);
    assert.equal(appB.start.status.farbe, "gruen");
  });

  await test("zwei Apps sehen Statuswechsel gegenseitig", async () => {
    appA.leeren();
    appB.leeren();
    appA.senden({ typ: "status_setzen", farbe: "gelb", dauer_s: null });
    const a = await appA.warte("status");
    const b = await appB.warte("status");
    assert.equal(a.farbe, "gelb");
    assert.equal(b.farbe, "gelb");
    assert.equal(b.bis, null);
    assert.equal(a.seit, b.seit, "beide Apps muessen dieselbe Aenderung sehen");
  });

  const display = await client("Display", "display");

  await test("Display bekommt Status, Apps sehen es online", async () => {
    assert.equal(display.start.status.farbe, "gelb");
    await appA.warte("geraet", 5000, (g) => g.online === true);
  });

  await test("Display meldet Stromquelle", async () => {
    appA.leeren();
    display.senden({ typ: "geraet", strom: "akku", akku_prozent: 40 });
    const g = await appA.warte("geraet");
    assert.equal(g.strom, "akku");
    assert.equal(g.akku_prozent, 40);
  });

  await test("ping wird mit pong beantwortet", async () => {
    display.senden("ping");
    await display.warte("pong");
  });

  await test("Anfrage, Antwort Ja", async () => {
    appA.leeren();
    appB.leeren();
    display.leeren();
    display.senden({ typ: "anfrage" });
    const anA = await appA.warte("anfrage");
    const anD = await display.warte("anfrage");
    assert.equal(anA.id, anD.id);
    assert.ok(anA.rest_ms > 0 && anA.rest_ms <= FRIST_S * 1000);

    appB.senden({ typ: "antwort", id: anA.id, ja: true });
    const antwort = await display.warte("antwort");
    assert.equal(antwort.ja, true);
    assert.equal((await appA.warte("antwort")).id, anA.id);
  });

  await test("doppelte Anfrage liefert dieselbe id", async () => {
    display.leeren();
    display.senden({ typ: "anfrage" });
    const erste = await display.warte("anfrage");
    display.senden({ typ: "anfrage" });
    const zweite = await display.warte("anfrage");
    assert.equal(zweite.id, erste.id);
    display.senden({ typ: "abbruch", id: erste.id });
    await display.warte("abbruch");
  });

  await test("Anfrage ohne Antwort laeuft ab", async () => {
    appA.leeren();
    display.leeren();
    display.senden({ typ: "anfrage" });
    const an = await display.warte("anfrage");
    const fristA = await appA.warte("frist_abgelaufen", (FRIST_S + 5) * 1000);
    const fristD = await display.warte("frist_abgelaufen", 2000);
    assert.equal(fristA.id, an.id);
    assert.equal(fristD.id, an.id);
  });

  await test("Antwort auf abgelaufene Anfrage wird abgewiesen", async () => {
    appA.leeren();
    appA.senden({ typ: "antwort", id: "gibt-es-nicht", ja: true });
    const f = await appA.warte("fehler");
    assert.match(f.grund, /Keine offene Anfrage/);
  });

  await test("Rollen sind getrennt", async () => {
    display.leeren();
    display.senden({ typ: "status_setzen", farbe: "rot", dauer_s: null });
    assert.match((await display.warte("fehler")).grund, /nicht erlaubt/);
    appA.leeren();
    appA.senden({ typ: "anfrage" });
    assert.match((await appA.warte("fehler")).grund, /nicht erlaubt/);
  });

  await test("ungueltige Nachrichten werden abgewiesen", async () => {
    appA.leeren();
    appA.senden("kein json");
    assert.match((await appA.warte("fehler")).grund, /JSON/);
    appA.senden({ typ: "status_setzen", farbe: "blau", dauer_s: null });
    assert.match((await appA.warte("fehler")).grund, /farbe/);
    appA.senden({ typ: "status_setzen", farbe: "rot", dauer_s: 0 });
    assert.match((await appA.warte("fehler")).grund, /dauer_s/);
  });

  await test("Status mit Dauer springt auf Gruen zurueck", async () => {
    appA.leeren();
    appA.senden({ typ: "status_setzen", farbe: "rot", dauer_s: 2 });
    const rot = await appA.warte("status");
    assert.equal(rot.farbe, "rot");
    assert.ok(rot.bis > rot.seit);
    const gruen = await display.warte("status", 8000).then(() => display.warte("status", 8000));
    assert.equal(gruen.farbe, "gruen");
  });

  await test("bei Gruen ist keine Anfrage noetig", async () => {
    display.leeren();
    display.senden({ typ: "anfrage" });
    assert.match((await display.warte("fehler")).grund, /Gruen/);
  });

  let zweitesDisplay = null;

  await test("neues Display ersetzt das alte", async () => {
    zweitesDisplay = await client("Display 2", "display");
    await new Promise((ok) => {
      if (display.ws.readyState === WebSocket.CLOSED) return ok();
      display.ws.addEventListener("close", ok);
    });
    assert.equal(display.ws.readyState, WebSocket.CLOSED);
  });

  await test("Apps sehen das Display offline", async () => {
    appA.leeren();
    await zweitesDisplay.schliessen();
    await appA.warte("geraet", 5000, (g) => g.online === false);
  });

  // Zustand fuer den Neustart vorbereiten
  appA.leeren();
  appA.senden({ typ: "status_setzen", farbe: "gelb", dauer_s: null });
  await appA.warte("status");

  await appA.schliessen();
  await appB.schliessen();

  console.log("Neustart von wrangler dev …");
  await serverStoppen();
  await serverStarten();

  await test("Status ueberlebt einen Neustart", async () => {
    const app = await client("App nach Neustart", "app");
    assert.equal(app.start.status.farbe, "gelb");
    await app.schliessen();
  });

  await serverStoppen();
  rmSync(speicher, { recursive: true, force: true });

  const fehler = ergebnisse.filter(([ok]) => !ok).length;
  console.log(`\n${ergebnisse.length - fehler} von ${ergebnisse.length} Tests bestanden.`);
  process.exit(fehler === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await serverStoppen();
  rmSync(speicher, { recursive: true, force: true });
  process.exit(1);
});
