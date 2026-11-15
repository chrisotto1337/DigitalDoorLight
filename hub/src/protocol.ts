// Nachrichten zwischen Display, Hub und App. Beschreibung: docs/protokoll.md

export type Rolle = "display" | "app";
export type Farbe = "gruen" | "gelb" | "rot";
export type Strom = "usb" | "akku";

export const FARBEN: readonly Farbe[] = ["gruen", "gelb", "rot"];

// Grenzen fuer die automatische Rueckkehr auf Gruen
export const MIN_DAUER_S = 1;
export const MAX_DAUER_S = 24 * 60 * 60;

// ---------- Vom Client an den Hub ----------

export type ClientNachricht =
  | { typ: "status_setzen"; farbe: Farbe; dauer_s: number | null }
  | { typ: "antwort"; id: string; ja: boolean }
  | { typ: "anfrage" }
  | { typ: "abbruch"; id: string }
  | { typ: "geraet"; strom: Strom; akku_prozent: number | null };

const ERLAUBT: Record<ClientNachricht["typ"], Rolle> = {
  status_setzen: "app",
  antwort: "app",
  anfrage: "display",
  abbruch: "display",
  geraet: "display",
};

// ---------- Vom Hub an die Clients ----------

export type HubNachricht =
  | { typ: "status"; farbe: Farbe; seit: number; bis: number | null }
  | { typ: "anfrage"; id: string; start: number; frist: number; rest_ms: number }
  | { typ: "antwort"; id: string; ja: boolean }
  | { typ: "frist_abgelaufen"; id: string }
  | { typ: "abbruch"; id: string }
  | {
      typ: "geraet";
      online: boolean;
      zuletzt: number | null;
      strom: Strom | null;
      akku_prozent: number | null;
    }
  | { typ: "fehler"; grund: string };

export type Pruefung =
  | { ok: true; nachricht: ClientNachricht }
  | { ok: false; grund: string };

const MAX_LAENGE = 2048;
const MAX_ID_LAENGE = 64;

function istObjekt(wert: unknown): wert is Record<string, unknown> {
  return typeof wert === "object" && wert !== null && !Array.isArray(wert);
}

function istId(wert: unknown): wert is string {
  return typeof wert === "string" && wert.length > 0 && wert.length <= MAX_ID_LAENGE;
}

// Prueft Format und Berechtigung einer eingehenden Nachricht.
export function pruefeNachricht(roh: string | ArrayBuffer, rolle: Rolle): Pruefung {
  if (typeof roh !== "string") {
    return { ok: false, grund: "Nur Textnachrichten werden angenommen" };
  }
  if (roh.length > MAX_LAENGE) {
    return { ok: false, grund: "Nachricht zu lang" };
  }

  let daten: unknown;
  try {
    daten = JSON.parse(roh);
  } catch {
    return { ok: false, grund: "Kein gueltiges JSON" };
  }
  if (!istObjekt(daten) || typeof daten.typ !== "string") {
    return { ok: false, grund: "Feld typ fehlt" };
  }

  const typ = daten.typ as ClientNachricht["typ"];
  const erlaubteRolle = ERLAUBT[typ];
  if (erlaubteRolle === undefined) {
    return { ok: false, grund: `Unbekannter typ: ${String(daten.typ).slice(0, 32)}` };
  }
  if (erlaubteRolle !== rolle) {
    return { ok: false, grund: `${typ} ist fuer ${rolle} nicht erlaubt` };
  }

  switch (typ) {
    case "status_setzen": {
      const farbe = daten.farbe;
      if (typeof farbe !== "string" || !FARBEN.includes(farbe as Farbe)) {
        return { ok: false, grund: "farbe muss gruen, gelb oder rot sein" };
      }
      const dauer = daten.dauer_s ?? null;
      if (dauer !== null) {
        if (
          typeof dauer !== "number" ||
          !Number.isInteger(dauer) ||
          dauer < MIN_DAUER_S ||
          dauer > MAX_DAUER_S
        ) {
          return {
            ok: false,
            grund: `dauer_s muss null oder eine ganze Zahl von ${MIN_DAUER_S} bis ${MAX_DAUER_S} sein`,
          };
        }
      }
      return { ok: true, nachricht: { typ, farbe: farbe as Farbe, dauer_s: dauer } };
    }
    case "antwort": {
      if (!istId(daten.id)) {
        return { ok: false, grund: "id fehlt" };
      }
      if (typeof daten.ja !== "boolean") {
        return { ok: false, grund: "ja muss true oder false sein" };
      }
      return { ok: true, nachricht: { typ, id: daten.id, ja: daten.ja } };
    }
    case "anfrage":
      return { ok: true, nachricht: { typ } };
    case "abbruch": {
      if (!istId(daten.id)) {
        return { ok: false, grund: "id fehlt" };
      }
      return { ok: true, nachricht: { typ, id: daten.id } };
    }
    case "geraet": {
      if (daten.strom !== "usb" && daten.strom !== "akku") {
        return { ok: false, grund: "strom muss usb oder akku sein" };
      }
      const akku = daten.akku_prozent ?? null;
      if (
        akku !== null &&
        (typeof akku !== "number" || !Number.isInteger(akku) || akku < 0 || akku > 100)
      ) {
        return { ok: false, grund: "akku_prozent muss null oder 0 bis 100 sein" };
      }
      return { ok: true, nachricht: { typ, strom: daten.strom, akku_prozent: akku } };
    }
  }
}
