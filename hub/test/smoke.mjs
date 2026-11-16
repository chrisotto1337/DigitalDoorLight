// Ablauftest fuer den Hub: startet "wrangler dev" und spielt Display und App durch.
// Aufruf: npm test   (braucht Node 22 oder neuer)

import { spawn } from "node:child_process";
import { createECDH, createHash, randomBytes, webcrypto } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import ece from "http_ece";

import { nachtStand } from "../src/nacht.ts";

const PORT = 8799;
const BASIS = `http://127.0.0.1:${PORT}`;
const WS_BASIS = `ws://127.0.0.1:${PORT}`;
const DISPLAY_KEY = "test-display-schluessel";
const APP_KEY = "test-app-schluessel";
const FRIST_S = 2;

const speicher = mkdtempSync(join(tmpdir(), "tuerampel-hub-"));
let server = null;

// Firmware fuer das Update: eine Attrappe, falls kein echter Build daliegt
const FIRMWARE_DATEI = new URL("../public/firmware/tuerampel.bin", import.meta.url);
const FIRMWARE_ATTRAPPE = !existsSync(FIRMWARE_DATEI);
if (FIRMWARE_ATTRAPPE) {
  mkdirSync(new URL(".", FIRMWARE_DATEI), { recursive: true });
  writeFileSync(FIRMWARE_DATEI, randomBytes(50_000));
}
const FIRMWARE = readFileSync(FIRMWARE_DATEI);
const FIRMWARE_MD5 = createHash("md5").update(FIRMWARE).digest("hex");
const FIRMWARE_VERSION = "test-1";

function aufraeumen() {
  pushServer.close();
  rmSync(speicher, { recursive: true, force: true });
  if (FIRMWARE_ATTRAPPE) rmSync(FIRMWARE_DATEI, { force: true });
}

// ---------- Nachgebauter Push-Dienst ----------
// Der Hub darf im Test an 127.0.0.1 pushen (PUSH_LOKAL_ERLAUBT).

const push = { eingang: [], wartende: [], basis: "" };

const pushServer = createServer((req, res) => {
  const teile = [];
  req.on("data", (d) => teile.push(d));
  req.on("end", () => {
    const eintrag = { pfad: req.url, kopf: req.headers, inhalt: Buffer.concat(teile) };
    // /weg spielt ein Abo, das der Dienst nicht mehr kennt
    res.writeHead(req.url.startsWith("/weg") ? 410 : 201);
    res.end();
    const index = push.wartende.findIndex((w) => w.pfad === eintrag.pfad);
    if (index >= 0) push.wartende.splice(index, 1)[0].ok(eintrag);
    else push.eingang.push(eintrag);
  });
});

function pushErwarten(pfad, ms = 5000) {
  const index = push.eingang.findIndex((e) => e.pfad === pfad);
  if (index >= 0) return Promise.resolve(push.eingang.splice(index, 1)[0]);
  return new Promise((ok, fehler) => {
    const eintrag = {
      pfad,
      ok: (e) => {
        clearTimeout(eintrag.timer);
        ok(e);
      },
      timer: setTimeout(() => {
        push.wartende.splice(push.wartende.indexOf(eintrag), 1);
        fehler(new Error(`kein Push an ${pfad} nach ${ms} ms`));
      }, ms),
    };
    push.wartende.push(eintrag);
  });
}

// Ein Abo, wie es ein Browser liefern wuerde, mit den Schluesseln zum Entschluesseln
function browserAbo(pfad) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    json: {
      endpoint: `${push.basis}${pfad}`,
      expirationTime: null,
      keys: { p256dh: ecdh.getPublicKey("base64url"), auth: auth.toString("base64url") },
    },
  };
}

function pushLesen(eintrag, browser) {
  const text = ece.decrypt(eintrag.inhalt, { version: "aes128gcm", privateKey: browser.ecdh, authSecret: browser.auth });
  return JSON.parse(text.toString());
}

async function pruefeVapid(kopf, oeffentlich) {
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(kopf) ?? [];
  assert.equal(k, oeffentlich, "Push mit anderem Schluessel als angekuendigt");
  const [a, b, signatur] = jwt.split(".");
  const schluessel = await webcrypto.subtle.importKey(
    "raw",
    Buffer.from(k, "base64url"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const gueltig = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    schluessel,
    Buffer.from(signatur, "base64url"),
    Buffer.from(`${a}.${b}`),
  );
  assert.ok(gueltig, "VAPID-Signatur ungueltig");
  return JSON.parse(Buffer.from(b, "base64url").toString());
}

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
      "--var", "PUSH_LOKAL_ERLAUBT:1",
      "--var", `FIRMWARE_VERSION:${FIRMWARE_VERSION}`,
      "--var", `FIRMWARE_MD5:${FIRMWARE_MD5}`,
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

  // Alle Nachrichten bis einschliesslich der ersten vom Typ, zum Beispiel die Begruessung.
  bisZu(typ, ms = 5000) {
    return new Promise((ok, fehler) => {
      const pruefen = () => {
        const index = this.posteingang.findIndex((n) => n.typ === typ);
        if (index >= 0) {
          clearInterval(takt);
          clearTimeout(timer);
          ok(this.posteingang.splice(0, index + 1));
        }
      };
      const takt = setInterval(pruefen, 10);
      const timer = setTimeout(() => {
        clearInterval(takt);
        fehler(new Error(`${this.name}: keine Nachricht "${typ}" nach ${ms} ms`));
      }, ms);
      pruefen();
    });
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
  // Begruessung: status, laufende anfrage, nacht, dann an das Display firmware,
  // an die App push_schluessel und geraet
  const gruss = await c.bisZu(rolle === "app" ? "geraet" : "firmware");
  c.start = {};
  for (const n of gruss) {
    if (n.typ === "anfrage") {
      // Bleibt im Posteingang, Tests warten darauf
      c.posteingang.unshift(n);
    } else {
      c.start[n.typ === "push_schluessel" ? "push" : n.typ] = n;
    }
  }
  assert.deepEqual(
    gruss.map((n) => n.typ).filter((t) => t !== "anfrage"),
    rolle === "app" ? ["status", "nacht", "push_schluessel", "geraet"] : ["status", "nacht", "firmware"],
    `${name}: Begruessung in falscher Reihenfolge`,
  );
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
  await new Promise((ok) => pushServer.listen(0, "127.0.0.1", ok));
  push.basis = `http://127.0.0.1:${pushServer.address().port}`;

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

  await test("App wird ausgeliefert", async () => {
    const r = await fetch(`${BASIS}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(await r.text(), /Türampel/);
    for (const datei of ["/app.js", "/app.css", "/sw.js", "/manifest.webmanifest", "/icons/icon-180.png"]) {
      const d = await fetch(`${BASIS}${datei}`);
      assert.equal(d.status, 200, datei);
      await d.arrayBuffer();
    }
    const kopf = await fetch(`${BASIS}/_headers`);
    assert.notEqual(kopf.status, 200, "_headers darf nicht oeffentlich sein");
    await kopf.arrayBuffer();
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

  await test("gleiche Farbe mit neuer Dauer behaelt seit", async () => {
    appA.leeren();
    appA.senden({ typ: "status_setzen", farbe: "gelb", dauer_s: 3600 });
    const mitDauer = await appA.warte("status");
    assert.equal(mitDauer.farbe, "gelb");
    assert.ok(mitDauer.bis > Date.now());
    appA.senden({ typ: "status_setzen", farbe: "gelb", dauer_s: null });
    const ohneDauer = await appA.warte("status");
    assert.equal(ohneDauer.seit, mitDauer.seit);
    assert.equal(ohneDauer.bis, null);
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

  // ---------- Push ----------

  const pushSchluessel = appA.start.push.schluessel;
  const handy = browserAbo("/abo/handy");

  await test("Apps bekommen denselben Push-Schluessel", async () => {
    assert.equal(Buffer.from(pushSchluessel, "base64url").length, 65);
    assert.equal(appB.start.push.schluessel, pushSchluessel);
  });

  await test("Push-Abo mit fremdem Ziel wird abgewiesen", async () => {
    appA.leeren();
    const fremd = browserAbo("/x").json;
    appA.senden({ typ: "push_anmelden", abo: { ...fremd, endpoint: "https://evil.example/push" } });
    assert.match((await appA.warte("fehler")).grund, /Push-Dienst/);
    appA.senden({ typ: "push_anmelden", abo: { ...fremd, keys: { ...fremd.keys, auth: "zu-kurz" } } });
    assert.match((await appA.warte("fehler")).grund, /keys/);
    appA.senden({ typ: "push_test", endpoint: fremd.endpoint, verzoegerung_s: 99 });
    assert.match((await appA.warte("fehler")).grund, /verzoegerung_s/);
    display.leeren();
    display.senden({ typ: "push_anmelden", abo: fremd });
    assert.match((await display.warte("fehler")).grund, /nicht erlaubt/);
  });

  await test("Push-Abo anmelden", async () => {
    appA.leeren();
    appA.senden({ typ: "push_anmelden", abo: handy.json });
    const s = await appA.warte("push_status");
    assert.equal(s.endpoint, handy.json.endpoint);
    assert.equal(s.aktiv, true);
    // Erneut anmelden, wie bei jedem Verbindungsaufbau, schadet nicht
    appA.senden({ typ: "push_anmelden", abo: handy.json });
    assert.equal((await appA.warte("push_status")).aktiv, true);
  });

  await test("Anfrage schickt Push", async () => {
    display.leeren();
    display.senden({ typ: "anfrage" });
    const an = await display.warte("anfrage");
    const eintrag = await pushErwarten("/abo/handy");
    const daten = pushLesen(eintrag, handy);
    assert.equal(daten.art, "anfrage");
    assert.equal(daten.id, an.id);
    assert.equal(daten.frist, an.frist);
    assert.equal(eintrag.kopf.urgency, "high");
    assert.equal(eintrag.kopf.topic, "anfrage");
    assert.ok(Number(eintrag.kopf.ttl) >= 1 && Number(eintrag.kopf.ttl) <= FRIST_S);
    const jwt = await pruefeVapid(eintrag.kopf.authorization, pushSchluessel);
    assert.equal(jwt.aud, push.basis);
    assert.equal(jwt.sub, BASIS);
    appA.senden({ typ: "antwort", id: an.id, ja: false });
    await display.warte("antwort");
  });

  await test("verpasste Anfrage schickt Push", async () => {
    display.leeren();
    display.senden({ typ: "anfrage" });
    const an = await display.warte("anfrage");
    assert.equal(pushLesen(await pushErwarten("/abo/handy"), handy).art, "anfrage");
    await display.warte("frist_abgelaufen", (FRIST_S + 5) * 1000);
    const eintrag = await pushErwarten("/abo/handy");
    const daten = pushLesen(eintrag, handy);
    assert.equal(daten.art, "verpasst");
    assert.equal(daten.id, an.id);
    assert.equal(daten.start, an.start);
    assert.equal(eintrag.kopf.urgency, "normal");
    assert.equal(eintrag.kopf.topic, "anfrage");
  });

  await test("Test-Mitteilung", async () => {
    appA.leeren();
    appA.senden({ typ: "push_test", endpoint: handy.json.endpoint, verzoegerung_s: 0 });
    assert.equal(pushLesen(await pushErwarten("/abo/handy"), handy).art, "test");
    const e = await appA.warte("push_ergebnis");
    assert.equal(e.ok, true);
    assert.equal(e.grund, null);

    appA.senden({ typ: "push_test", endpoint: `${push.basis}/unbekannt`, verzoegerung_s: 0 });
    const unbekannt = await appA.warte("push_ergebnis");
    assert.equal(unbekannt.ok, false);
    assert.match(unbekannt.grund, /nicht angemeldet/);
  });

  await test("erloschenes Abo wird entfernt", async () => {
    appA.leeren();
    const weg = browserAbo("/weg");
    appA.senden({ typ: "push_anmelden", abo: weg.json });
    await appA.warte("push_status");
    appA.senden({ typ: "push_test", endpoint: weg.json.endpoint, verzoegerung_s: 0 });
    await pushErwarten("/weg");
    const e = await appA.warte("push_ergebnis");
    assert.equal(e.ok, false);
    assert.match(e.grund, /^410/);
    appA.senden({ typ: "push_test", endpoint: weg.json.endpoint, verzoegerung_s: 0 });
    assert.match((await appA.warte("push_ergebnis")).grund, /nicht angemeldet/);
  });

  await test("abgemeldetes Geraet bekommt keinen Push", async () => {
    appA.leeren();
    appA.senden({ typ: "push_abmelden", endpoint: handy.json.endpoint });
    assert.equal((await appA.warte("push_status")).aktiv, false);
    display.leeren();
    display.senden({ typ: "anfrage" });
    const an = await display.warte("anfrage");
    await assert.rejects(pushErwarten("/abo/handy", 1500), /kein Push/);
    display.senden({ typ: "abbruch", id: an.id });
    await display.warte("abbruch");
  });

  // ---------- Firmware ----------

  await test("Display bekommt die Firmware angeboten", async () => {
    assert.deepEqual(display.start.firmware, { typ: "firmware", version: FIRMWARE_VERSION, md5: FIRMWARE_MD5 });
    assert.equal(appA.start.geraet.firmware_neu, FIRMWARE_VERSION);
  });

  await test("Firmware nur mit Display-Schluessel", async () => {
    const pfad = `${BASIS}/firmware/tuerampel.bin`;
    assert.equal((await fetch(pfad)).status, 401);
    assert.equal((await fetch(`${pfad}?key=${APP_KEY}`)).status, 401);
    const r = await fetch(`${pfad}?key=${DISPLAY_KEY}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-md5"), FIRMWARE_MD5);
    assert.equal(r.headers.get("content-length"), String(FIRMWARE.length));
    assert.equal(r.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), FIRMWARE);
    assert.equal((await fetch(`${BASIS}/firmware/anderes.bin?key=${DISPLAY_KEY}`)).status, 404);
    assert.equal((await fetch(pfad + `?key=${DISPLAY_KEY}`, { method: "POST" })).status, 405);
  });

  await test("Display meldet seine Firmware", async () => {
    appA.leeren();
    display.senden({ typ: "geraet", strom: "usb", akku_prozent: null, firmware: "abc1234+lokal" });
    const g = await appA.warte("geraet", 5000, (n) => n.firmware === "abc1234+lokal");
    assert.equal(g.firmware_neu, FIRMWARE_VERSION);
    display.leeren();
    display.senden({ typ: "geraet", strom: "usb", akku_prozent: null, firmware: "kaputt version" });
    assert.match((await display.warte("fehler")).grund, /firmware/);
  });

  // ---------- Nachtruhe ----------

  await test("Begruessung enthaelt die Nachtruhe", async () => {
    for (const n of [appA.start.nacht, display.start.nacht]) {
      assert.equal(n.an, true);
      assert.equal(n.von, "22:00");
      assert.equal(n.bis, "07:00");
      assert.equal(n.zeitzone, "Europe/Berlin");
      const erwartet = nachtStand(n, Date.now());
      assert.equal(n.aktiv, erwartet.aktiv);
    }
  });

  await test("Nachtruhe pruefen", async () => {
    const gut = { typ: "nacht_setzen", an: true, von: "22:00", bis: "07:00", zeitzone: "Europe/Berlin" };
    appA.leeren();
    for (const [falsch, muster] of [
      [{ von: "22:00", bis: "22:00" }, /gleich/],
      [{ von: "25:00" }, /Uhrzeit/],
      [{ zeitzone: "Mars/Basis" }, /zeitzone/],
      [{ an: "ja" }, /an muss/],
    ]) {
      appA.senden({ ...gut, ...falsch });
      assert.match((await appA.warte("fehler")).grund, muster);
    }
    display.leeren();
    display.senden(gut);
    assert.match((await display.warte("fehler")).grund, /nicht erlaubt/);
  });

  await test("Nachtruhe setzen erreicht App und Display", async () => {
    appB.leeren();
    display.leeren();
    appA.senden({ typ: "nacht_setzen", an: false, von: "21:30", bis: "06:15", zeitzone: "America/New_York" });
    for (const c of [appB, display]) {
      const n = await c.warte("nacht");
      assert.deepEqual(
        { an: n.an, von: n.von, bis: n.bis, zeitzone: n.zeitzone, aktiv: n.aktiv, wechsel: n.wechsel },
        { an: false, von: "21:30", bis: "06:15", zeitzone: "America/New_York", aktiv: false, wechsel: null },
      );
    }
  });

  await test("Wechsel in die Nacht kommt von selbst", async () => {
    // Nacht ab der naechsten vollen Minute, in UTC
    if (60_000 - (Date.now() % 60_000) < 5000) await new Promise((ok) => setTimeout(ok, 5000));
    const minute = Math.floor(Date.now() / 60_000) % 1440;
    const uhr = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const von = uhr((minute + 1) % 1440);
    const bis = uhr((minute + 3) % 1440);
    display.leeren();
    appA.senden({ typ: "nacht_setzen", an: true, von, bis, zeitzone: "UTC" });
    const vorher = await display.warte("nacht");
    assert.equal(vorher.aktiv, false);
    assert.equal(vorher.wechsel, (Math.floor(Date.now() / 60_000) + 1) * 60_000);
    const nachher = await display.warte("nacht", 70_000, (n) => n.aktiv === true);
    assert.ok(Date.now() >= vorher.wechsel, "zu frueh gewechselt");
    assert.ok(Date.now() - vorher.wechsel < 10_000, "zu spaet gewechselt");
    assert.equal(nachher.wechsel, vorher.wechsel + 2 * 60_000);
    // Fuer den Rest: wieder die Standardwerte
    appA.senden({ typ: "nacht_setzen", an: true, von: "22:00", bis: "07:00", zeitzone: "Europe/Berlin" });
    await display.warte("nacht", 5000, (n) => n.von === "22:00");
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
    assert.equal(app.start.push.schluessel, pushSchluessel, "Push-Schluessel muss bleiben");
    assert.equal(app.start.geraet.firmware, "abc1234+lokal", "Firmware des Displays muss bleiben");
    assert.equal(app.start.nacht.von, "22:00");
    await app.schliessen();
  });

  await serverStoppen();
  aufraeumen();

  const fehler = ergebnisse.filter(([ok]) => !ok).length;
  console.log(`\n${ergebnisse.length - fehler} von ${ergebnisse.length} Tests bestanden.`);
  process.exit(fehler === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await serverStoppen();
  aufraeumen();
  process.exit(1);
});
