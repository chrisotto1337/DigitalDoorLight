// Prueft Verschluesselung und VAPID-Signatur aus src/webpush.ts.
// Entschluesselt wird mit http_ece, der Referenz, auf der auch die
// verbreitete Bibliothek web-push aufbaut. So testet sich der Code nicht selbst.
// Aufruf: npm run test:push   (Node 22.18 oder neuer)

import { createECDH, randomBytes, webcrypto } from "node:crypto";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import ece from "http_ece";

import {
  aboErloschen,
  ausBase64url,
  erlaubterEndpunkt,
  sendePush,
  vapidErzeugen,
  verschluesseln,
  zuBase64url,
} from "../src/webpush.ts";

const ergebnisse = [];

async function test(name, ablauf) {
  try {
    await ablauf();
    ergebnisse.push(true);
    console.log(`  ok    ${name}`);
  } catch (e) {
    ergebnisse.push(false);
    console.log(`  FEHLER ${name}\n         ${e.stack ?? e.message}`);
  }
}

// Ein Browser-Abo, wie es PushManager.subscribe() liefern wuerde
function browserAbo(endpoint) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    abo: { endpoint, p256dh: ecdh.getPublicKey("base64url"), auth: auth.toString("base64url") },
  };
}

function entschluesseln(inhalt, browser) {
  return ece.decrypt(Buffer.from(inhalt), {
    version: "aes128gcm",
    privateKey: browser.ecdh,
    authSecret: browser.auth,
  });
}

// Prueft den Authorization-Kopf und gibt den Inhalt des JWT zurueck.
async function pruefeVapid(kopf, vapid) {
  const treffer = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(kopf);
  assert.ok(treffer, `Authorization-Kopf hat falsches Format: ${kopf}`);
  const [, jwt, k] = treffer;
  assert.equal(k, vapid.oeffentlich);

  const [kopfTeil, inhaltTeil, signatur] = jwt.split(".");
  const jwtKopf = JSON.parse(Buffer.from(kopfTeil, "base64url").toString());
  assert.deepEqual(jwtKopf, { typ: "JWT", alg: "ES256" });

  const schluessel = await webcrypto.subtle.importKey(
    "raw",
    ausBase64url(k),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const gueltig = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    schluessel,
    ausBase64url(signatur),
    new TextEncoder().encode(`${kopfTeil}.${inhaltTeil}`),
  );
  assert.ok(gueltig, "Signatur passt nicht zum oeffentlichen Schluessel");
  return JSON.parse(Buffer.from(inhaltTeil, "base64url").toString());
}

// Kleiner Push-Dienst zum Mitschneiden
async function pushDienst(antwort = () => ({ status: 201, text: "" })) {
  const eingang = [];
  const server = createServer((req, res) => {
    const teile = [];
    req.on("data", (d) => teile.push(d));
    req.on("end", () => {
      eingang.push({ pfad: req.url, kopf: req.headers, inhalt: Buffer.concat(teile) });
      const { status, text } = antwort(req);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(text);
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const basis = `http://127.0.0.1:${server.address().port}`;
  return { eingang, basis, schliessen: () => new Promise((ok) => server.close(ok)) };
}

async function main() {
  console.log("Web Push:");

  await test("base64url hin und zurueck", async () => {
    for (const laenge of [0, 1, 2, 3, 16, 65]) {
      const daten = randomBytes(laenge);
      assert.deepEqual(Buffer.from(ausBase64url(zuBase64url(daten))), daten);
      assert.equal(zuBase64url(daten), daten.toString("base64url"));
    }
  });

  await test("VAPID-Schluessel hat das richtige Format", async () => {
    const vapid = await vapidErzeugen();
    const roh = ausBase64url(vapid.oeffentlich);
    assert.equal(roh.length, 65);
    assert.equal(roh[0], 4, "unkomprimierter Punkt beginnt mit 0x04");
    assert.equal(vapid.privat.kty, "EC");
    assert.equal(vapid.privat.crv, "P-256");
    assert.ok(vapid.privat.d);
  });

  await test("Verschluesselung laesst sich mit http_ece entschluesseln", async () => {
    const browser = browserAbo("https://web.push.apple.com/abc");
    for (const text of ["", "{}", JSON.stringify({ art: "anfrage", id: "x", text: "Tür äöü ß" }), "x".repeat(3000)]) {
      const geheim = await verschluesseln(new TextEncoder().encode(text), browser.abo);
      assert.equal(entschluesseln(geheim, browser).toString(), text);
    }
  });

  await test("Kopf der Nachricht nach RFC 8188", async () => {
    const browser = browserAbo("https://web.push.apple.com/abc");
    const geheim = await verschluesseln(new TextEncoder().encode("hallo"), browser.abo);
    const kopf = Buffer.from(geheim);
    assert.equal(kopf.readUInt32BE(16), 4096, "Datensatzgroesse");
    assert.equal(kopf[20], 65, "Laenge der Schluessel-ID");
    assert.equal(kopf[21], 4, "Schluessel-ID ist ein unkomprimierter Punkt");
    // 86 Byte Kopf, 5 Byte Text, 1 Byte Trenner, 16 Byte Pruefsumme
    assert.equal(geheim.length, 86 + 5 + 1 + 16);
  });

  await test("jede Nachricht hat eigenes Salz und eigenen Schluessel", async () => {
    const browser = browserAbo("https://web.push.apple.com/abc");
    const a = Buffer.from(await verschluesseln(new TextEncoder().encode("gleich"), browser.abo));
    const b = Buffer.from(await verschluesseln(new TextEncoder().encode("gleich"), browser.abo));
    assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16));
    assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86));
  });

  await test("falsche Schluessellaengen werden abgelehnt", async () => {
    const browser = browserAbo("https://web.push.apple.com/abc");
    await assert.rejects(verschluesseln(new Uint8Array(1), { ...browser.abo, auth: "AAAA" }));
    await assert.rejects(verschluesseln(new Uint8Array(3001), browser.abo), /zu gross/);
  });

  await test("nur bekannte Push-Dienste sind erlaubt", async () => {
    const gut = [
      "https://web.push.apple.com/QGx3",
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ];
    const schlecht = [
      "http://web.push.apple.com/QGx3",
      "https://push.apple.com.evil.example/x",
      "https://evilpush.apple.com.example/x",
      "https://example.com/web.push.apple.com",
      "https://notify.windows.com.example/x",
      "https://127.0.0.1/x",
      "http://127.0.0.1:9000/x",
      "kein url",
      `https://web.push.apple.com/${"a".repeat(1100)}`,
    ];
    for (const e of gut) assert.ok(erlaubterEndpunkt(e), e);
    for (const e of schlecht) assert.ok(!erlaubterEndpunkt(e), e);
    assert.ok(erlaubterEndpunkt("http://127.0.0.1:9000/x", true), "lokal nur mit Schalter");
    assert.ok(!erlaubterEndpunkt("http://localhost:9000/x", true));
  });

  await test("Senden: Kopfzeilen, JWT und Inhalt", async () => {
    const dienst = await pushDienst();
    try {
      const vapid = await vapidErzeugen();
      const browser = browserAbo(`${dienst.basis}/abo/1`);
      const daten = { art: "anfrage", id: "abc", start: 1, frist: 2 };
      const ergebnis = await sendePush(browser.abo, daten, vapid, "https://hub.example", {
        ttlS: 29.4,
        dringend: true,
        thema: "anfrage",
      });
      assert.deepEqual(ergebnis, { status: 201, grund: null });

      const [anfrage] = dienst.eingang;
      assert.equal(anfrage.pfad, "/abo/1");
      assert.equal(anfrage.kopf["content-encoding"], "aes128gcm");
      assert.equal(anfrage.kopf.ttl, "29");
      assert.equal(anfrage.kopf.urgency, "high");
      assert.equal(anfrage.kopf.topic, "anfrage");

      const jwt = await pruefeVapid(anfrage.kopf.authorization, vapid);
      assert.equal(jwt.aud, dienst.basis);
      assert.equal(jwt.sub, "https://hub.example");
      const rest = jwt.exp - Date.now() / 1000;
      assert.ok(rest > 11 * 3600 && rest <= 24 * 3600, "exp muss unter 24 Stunden liegen");

      assert.deepEqual(JSON.parse(entschluesseln(anfrage.inhalt, browser).toString()), daten);
    } finally {
      await dienst.schliessen();
    }
  });

  await test("JWT wird pro Push-Dienst wiederverwendet", async () => {
    const dienst = await pushDienst();
    try {
      const vapid = await vapidErzeugen();
      const optionen = { ttlS: 60, dringend: false };
      await sendePush(browserAbo(`${dienst.basis}/a`).abo, {}, vapid, "https://hub.example", optionen);
      await sendePush(browserAbo(`${dienst.basis}/b`).abo, {}, vapid, "https://hub.example", optionen);
      const [a, b] = dienst.eingang;
      assert.equal(a.kopf.authorization, b.kopf.authorization);
      assert.equal(b.kopf.urgency, "normal");
      assert.equal(b.kopf.topic, undefined);

      // Neuer Schluessel, neuer JWT
      const anderer = await vapidErzeugen();
      await sendePush(browserAbo(`${dienst.basis}/c`).abo, {}, anderer, "https://hub.example", optionen);
      assert.notEqual(dienst.eingang[2].kopf.authorization, a.kopf.authorization);
      await pruefeVapid(dienst.eingang[2].kopf.authorization, anderer);
    } finally {
      await dienst.schliessen();
    }
  });

  await test("Fehler des Push-Dienstes werden erkannt", async () => {
    const antworten = {
      "/weg": { status: 410, text: "" },
      "/apple": { status: 403, text: JSON.stringify({ reason: "BadJwtToken" }) },
      "/text": { status: 400, text: "kaputt" },
    };
    const dienst = await pushDienst((req) => antworten[req.url]);
    try {
      const vapid = await vapidErzeugen();
      const senden = (pfad) =>
        sendePush(browserAbo(`${dienst.basis}${pfad}`).abo, {}, vapid, "https://hub.example", { ttlS: 1, dringend: true });

      const weg = await senden("/weg");
      assert.equal(weg.status, 410);
      assert.ok(aboErloschen(weg));

      const apple = await senden("/apple");
      assert.deepEqual(apple, { status: 403, grund: "BadJwtToken" });
      assert.ok(!aboErloschen(apple));

      assert.deepEqual(await senden("/text"), { status: 400, grund: "kaputt" });
    } finally {
      await dienst.schliessen();
    }

    // Niemand hoert zu
    const vapid = await vapidErzeugen();
    const tot = await sendePush(browserAbo("http://127.0.0.1:9/x").abo, {}, vapid, "https://hub.example", {
      ttlS: 1,
      dringend: true,
    });
    assert.equal(tot.status, 0);
    assert.ok(tot.grund);
  });

  const fehler = ergebnisse.filter((ok) => !ok).length;
  console.log(`\n${ergebnisse.length - fehler} von ${ergebnisse.length} Tests bestanden.`);
  process.exit(fehler === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
