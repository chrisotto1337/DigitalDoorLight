// Nachtruhe des Displays: von wann bis wann es dunkel bleibt.
// Reine Rechnung ohne Speicher, damit sie sich in Node testen laesst.

export interface NachtEinstellung {
  an: boolean;
  von: string; // "HH:MM", Ortszeit
  bis: string; // "HH:MM", Ortszeit, darf vor "von" liegen (ueber Mitternacht)
  zeitzone: string; // IANA, etwa "Europe/Berlin"
}

export interface NachtStand {
  aktiv: boolean;
  // Naechster Wechsel zwischen Tag und Nacht, Unix-Zeit in ms. null bei "aus".
  wechsel: number | null;
}

export const NACHT_STANDARD: NachtEinstellung = {
  an: true,
  von: "22:00",
  bis: "07:00",
  zeitzone: "Europe/Berlin",
};

const UHRZEIT = /^([01]\d|2[0-3]):[0-5]\d$/;

export function istUhrzeit(wert: unknown): wert is string {
  return typeof wert === "string" && UHRZEIT.test(wert);
}

const formate = new Map<string, Intl.DateTimeFormat>();

function format(zeitzone: string): Intl.DateTimeFormat {
  let f = formate.get(zeitzone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zeitzone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formate.set(zeitzone, f);
  }
  return f;
}

export function istZeitzone(wert: unknown): wert is string {
  if (typeof wert !== "string" || wert.length === 0 || wert.length > 64) return false;
  try {
    format(wert);
    return true;
  } catch {
    return false;
  }
}

function minuten(uhrzeit: string): number {
  return Number(uhrzeit.slice(0, 2)) * 60 + Number(uhrzeit.slice(3, 5));
}

interface Ortszeit {
  jahr: number;
  monat: number;
  tag: number;
  minute: number; // seit Mitternacht
}

function ortszeit(zeitpunkt: number, zeitzone: string): Ortszeit {
  const teile: Record<string, number> = {};
  for (const t of format(zeitzone).formatToParts(zeitpunkt)) {
    if (t.type !== "literal") teile[t.type] = Number(t.value);
  }
  return { jahr: teile.year, monat: teile.month, tag: teile.day, minute: teile.hour * 60 + teile.minute };
}

// Abstand der Ortszeit zu UTC in Minuten, zu diesem Zeitpunkt
function versatz(zeitpunkt: number, zeitzone: string): number {
  const o = ortszeit(zeitpunkt, zeitzone);
  const alsUtc = Date.UTC(o.jahr, o.monat - 1, o.tag, 0, o.minute);
  const ganzeMinute = Math.floor(zeitpunkt / 60_000) * 60_000;
  return Math.round((alsUtc - ganzeMinute) / 60_000);
}

// Ortszeit an einem Kalendertag in einen Zeitpunkt umrechnen.
// Faellt die Uhrzeit in die Luecke der Sommerzeit-Umstellung, kommt der Moment danach heraus.
function zeitpunktVon(jahr: number, monat: number, tag: number, minute: number, zeitzone: string): number {
  const annahme = Date.UTC(jahr, monat - 1, tag, 0, minute);
  let ergebnis = annahme - versatz(annahme, zeitzone) * 60_000;
  ergebnis = annahme - versatz(ergebnis, zeitzone) * 60_000;
  return ergebnis;
}

export function nachtStand(e: NachtEinstellung, jetzt: number): NachtStand {
  if (!e.an) {
    return { aktiv: false, wechsel: null };
  }
  const von = minuten(e.von);
  const bis = minuten(e.bis);
  const o = ortszeit(jetzt, e.zeitzone);
  const aktiv = von < bis ? o.minute >= von && o.minute < bis : o.minute >= von || o.minute < bis;

  // Der naechste Wechsel liegt heute, morgen oder spaetestens uebermorgen.
  const ziel = aktiv ? bis : von;
  for (let tage = 0; tage <= 2; tage++) {
    const datum = new Date(Date.UTC(o.jahr, o.monat - 1, o.tag + tage));
    const kandidat = zeitpunktVon(
      datum.getUTCFullYear(),
      datum.getUTCMonth() + 1,
      datum.getUTCDate(),
      ziel,
      e.zeitzone,
    );
    if (kandidat > jetzt) {
      return { aktiv, wechsel: kandidat };
    }
  }
  return { aktiv, wechsel: null };
}
