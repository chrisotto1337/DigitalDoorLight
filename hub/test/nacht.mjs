// Prueft die Rechnung fuer die Nachtruhe in src/nacht.ts, auch ueber die
// Umstellung auf Sommer- und Winterzeit.
// Aufruf: node test/nacht.mjs   (Node 22.18 oder neuer)

import assert from "node:assert/strict";

import { NACHT_STANDARD, istUhrzeit, istZeitzone, nachtStand } from "../src/nacht.ts";

const ergebnisse = [];

function test(name, ablauf) {
  try {
    ablauf();
    ergebnisse.push(true);
    console.log(`  ok    ${name}`);
  } catch (e) {
    ergebnisse.push(false);
    console.log(`  FEHLER ${name}\n         ${e.stack ?? e.message}`);
  }
}

const utc = (text) => Date.parse(`${text}Z`);
const berlin = { ...NACHT_STANDARD }; // 22:00 bis 07:00, Europe/Berlin

function ortsUhrzeit(zeitpunkt, zeitzone) {
  return new Intl.DateTimeFormat("de-DE", { timeZone: zeitzone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(zeitpunkt);
}

console.log("Nachtruhe:");

test("Eingaben pruefen", () => {
  for (const gut of ["00:00", "07:00", "22:30", "23:59"]) assert.ok(istUhrzeit(gut), gut);
  for (const schlecht of ["24:00", "7:00", "07:60", "0700", "", null, 700]) assert.ok(!istUhrzeit(schlecht), String(schlecht));
  for (const gut of ["Europe/Berlin", "UTC", "America/New_York", "Asia/Kolkata"]) assert.ok(istZeitzone(gut), gut);
  for (const schlecht of ["Mars/Basis", "", null, "x".repeat(65)]) assert.ok(!istZeitzone(schlecht), String(schlecht));
});

test("Winterzeit: Tag, Beginn, mitten in der Nacht, Ende", () => {
  // 16.11.2026, Berlin ist UTC+1
  assert.deepEqual(nachtStand(berlin, utc("2026-11-16T20:59:00")), { aktiv: false, wechsel: utc("2026-11-16T21:00:00") });
  assert.deepEqual(nachtStand(berlin, utc("2026-11-16T21:00:00")), { aktiv: true, wechsel: utc("2026-11-17T06:00:00") });
  assert.deepEqual(nachtStand(berlin, utc("2026-11-17T02:00:00")), { aktiv: true, wechsel: utc("2026-11-17T06:00:00") });
  assert.deepEqual(nachtStand(berlin, utc("2026-11-17T06:00:00")), { aktiv: false, wechsel: utc("2026-11-17T21:00:00") });
});

test("Sommerzeit", () => {
  // 15.07.2026, Berlin ist UTC+2
  assert.deepEqual(nachtStand(berlin, utc("2026-07-15T12:00:00")), { aktiv: false, wechsel: utc("2026-07-15T20:00:00") });
  assert.deepEqual(nachtStand(berlin, utc("2026-07-15T23:00:00")), { aktiv: true, wechsel: utc("2026-07-16T05:00:00") });
});

test("Nacht ueber die Umstellung auf Sommerzeit", () => {
  // 28.03.2027: 02:00 MEZ wird 03:00 MESZ
  assert.deepEqual(nachtStand(berlin, utc("2027-03-27T21:30:00")), { aktiv: true, wechsel: utc("2027-03-28T05:00:00") });
});

test("Nacht ueber die Umstellung auf Winterzeit", () => {
  // 25.10.2026: 03:00 MESZ wird 02:00 MEZ
  assert.deepEqual(nachtStand(berlin, utc("2026-10-24T21:00:00")), { aktiv: true, wechsel: utc("2026-10-25T06:00:00") });
  assert.deepEqual(nachtStand(berlin, utc("2026-10-25T06:00:00")), { aktiv: false, wechsel: utc("2026-10-25T21:00:00") });
});

test("Uhrzeit in der Luecke der Sommerzeit", () => {
  // 02:30 gibt es am 28.03.2027 nicht, es gilt der Moment danach
  const e = { ...berlin, von: "02:30", bis: "06:00" };
  const { aktiv, wechsel } = nachtStand(e, utc("2027-03-27T23:00:00"));
  assert.equal(aktiv, false);
  assert.equal(ortsUhrzeit(wechsel, e.zeitzone), "03:30");
});

test("Ruhe am Tag, ohne Mitternacht", () => {
  const e = { ...berlin, von: "09:00", bis: "17:00" };
  assert.deepEqual(nachtStand(e, utc("2026-11-16T07:59:00")), { aktiv: false, wechsel: utc("2026-11-16T08:00:00") });
  assert.deepEqual(nachtStand(e, utc("2026-11-16T12:00:00")), { aktiv: true, wechsel: utc("2026-11-16T16:00:00") });
  assert.deepEqual(nachtStand(e, utc("2026-11-16T16:00:00")), { aktiv: false, wechsel: utc("2026-11-17T08:00:00") });
});

test("ausgeschaltet", () => {
  assert.deepEqual(nachtStand({ ...berlin, an: false }, utc("2026-11-16T23:00:00")), { aktiv: false, wechsel: null });
});

test("andere Zeitzone", () => {
  const e = { an: true, von: "22:00", bis: "06:30", zeitzone: "America/New_York" };
  // 16.11.2026, New York ist UTC-5
  assert.deepEqual(nachtStand(e, utc("2026-11-17T04:00:00")), { aktiv: true, wechsel: utc("2026-11-17T11:30:00") });
});

test("ein Jahr lang: jeder Wechsel kippt den Zustand und trifft die Uhrzeit", () => {
  const varianten = [
    berlin,
    { ...berlin, von: "23:15", bis: "06:45" },
    { ...berlin, von: "09:00", bis: "17:00" },
    { an: true, von: "21:00", bis: "08:00", zeitzone: "Australia/Sydney" },
  ];
  for (const e of varianten) {
    let jetzt = utc("2026-01-01T00:00:00");
    const ende = utc("2027-01-01T00:00:00");
    let wechselZahl = 0;
    while (jetzt < ende) {
      const stand = nachtStand(e, jetzt);
      assert.ok(stand.wechsel > jetzt, "Wechsel muss in der Zukunft liegen");
      assert.ok(stand.wechsel - jetzt <= 25 * 3600_000, "Wechsel spaetestens nach 25 Stunden");
      assert.equal(nachtStand(e, stand.wechsel - 1).aktiv, stand.aktiv, "kurz davor gilt noch der alte Zustand");
      assert.equal(nachtStand(e, stand.wechsel).aktiv, !stand.aktiv, "am Wechsel kippt der Zustand");
      assert.equal(ortsUhrzeit(stand.wechsel, e.zeitzone), stand.aktiv ? e.bis : e.von);
      jetzt = stand.wechsel;
      wechselZahl++;
    }
    assert.ok(wechselZahl >= 728 && wechselZahl <= 732, `${wechselZahl} Wechsel in einem Jahr`);
  }
});

const fehler = ergebnisse.filter((ok) => !ok).length;
console.log(`\n${ergebnisse.length - fehler} von ${ergebnisse.length} Tests bestanden.`);
process.exit(fehler === 0 ? 0 : 1);
