// Prueft den ausgerollten Hub, ohne seinen Zustand zu veraendern.
// Aufruf: APP_KEY=... DEVICE_KEY=... node test/live.mjs https://tuerampel-hub.chris-otto.workers.dev

import assert from "node:assert/strict";

const basis = (process.argv[2] ?? "").replace(/\/+$/, "");
const { APP_KEY, DEVICE_KEY } = process.env;

if (!/^https?:\/\//.test(basis)) {
  console.error("Adresse des Hubs fehlt, zum Beispiel https://tuerampel-hub.<subdomain>.workers.dev");
  process.exit(2);
}
if (!APP_KEY || !DEVICE_KEY) {
  console.error("APP_KEY und DEVICE_KEY muessen gesetzt sein");
  process.exit(2);
}

const pruefungen = [
  ["Hub antwortet", async () => {
    const r = await fetch(`${basis}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  }],
  ["falscher Schluessel wird abgewiesen", async () => {
    const r = await fetch(`${basis}/ws/app?key=falsch`);
    assert.equal(r.status, 401);
  }],
  // 426 heisst: Schluessel angenommen, nur der WebSocket fehlt.
  ["Display-Schluessel ist gesetzt", async () => {
    const r = await fetch(`${basis}/ws/display?key=${encodeURIComponent(DEVICE_KEY)}`);
    assert.equal(r.status, 426, `HTTP ${r.status}: ${await r.text()}`);
  }],
  ["App-Schluessel ist gesetzt", async () => {
    const r = await fetch(`${basis}/ws/app?key=${encodeURIComponent(APP_KEY)}`);
    assert.equal(r.status, 426, `HTTP ${r.status}: ${await r.text()}`);
  }],
  ["App-Verbindung bekommt den Status", async () => {
    const adresse = `${basis.replace(/^http/, "ws")}/ws/app?key=${encodeURIComponent(APP_KEY)}`;
    const status = await new Promise((ok, fehler) => {
      const ws = new WebSocket(adresse);
      const timer = setTimeout(() => {
        ws.close();
        fehler(new Error("kein Status nach 10 Sekunden"));
      }, 10_000);
      ws.onerror = () => fehler(new Error("Verbindung fehlgeschlagen"));
      ws.onmessage = (e) => {
        const n = JSON.parse(String(e.data));
        if (n.typ === "status") {
          clearTimeout(timer);
          ws.close();
          ok(n);
        }
      };
    });
    assert.ok(["gruen", "gelb", "rot"].includes(status.farbe));
    console.log(`         Ampel steht auf ${status.farbe}`);
  }],
];

let fehler = 0;
console.log(`Pruefe ${basis}`);
for (const [name, ablauf] of pruefungen) {
  try {
    await ablauf();
    console.log(`  ok     ${name}`);
  } catch (e) {
    fehler++;
    console.log(`  FEHLER ${name}\n         ${e.message}`);
  }
}
process.exit(fehler === 0 ? 0 : 1);
