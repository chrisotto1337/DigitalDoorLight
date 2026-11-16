// Nachrichten zwischen Display, Hub und App. Beschreibung: docs/protokoll.md

import { erlaubterEndpunkt, type PushAbo } from "./webpush";

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
  | { typ: "geraet"; strom: Strom; akku_prozent: number | null }
  | { typ: "push_anmelden"; abo: PushAbo }
  | { typ: "push_abmelden"; endpoint: string }
  | { typ: "push_test"; endpoint: string; verzoegerung_s: number };

const ERLAUBT: Record<ClientNachricht["typ"], Rolle> = {
  status_setzen: "app",
  antwort: "app",
  anfrage: "display",
  abbruch: "display",
  geraet: "display",
  push_anmelden: "app",
  push_abmelden: "app",
  push_test: "app",
};

// Wartezeit vor einer Test-Mitteilung, damit man das Handy sperren kann
export const MAX_TEST_VERZOEGERUNG_S = 10;

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
  | { typ: "push_schluessel"; schluessel: string }
  | { typ: "push_status"; endpoint: string; aktiv: boolean }
  | { typ: "push_ergebnis"; ok: boolean; grund: string | null }
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

// base64url ohne Auffuellung, mit genau dieser Laenge
function istBase64url(wert: unknown, laenge: number): wert is string {
  return typeof wert === "string" && wert.length === laenge && /^[A-Za-z0-9_-]+$/.test(wert);
}

function ohneAuffuellung(wert: unknown): unknown {
  return typeof wert === "string" ? wert.replace(/=+$/, "") : wert;
}

export interface PruefOptionen {
  // Nur fuer lokale Tests: Push-Ziele auf 127.0.0.1 zulassen
  lokalePushZiele?: boolean;
}

// Prueft Format und Berechtigung einer eingehenden Nachricht.
export function pruefeNachricht(
  roh: string | ArrayBuffer,
  rolle: Rolle,
  optionen: PruefOptionen = {},
): Pruefung {
  const endpunktOk = (wert: unknown): wert is string =>
    typeof wert === "string" && erlaubterEndpunkt(wert, optionen.lokalePushZiele ?? false);

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
    case "push_anmelden": {
      // Format von PushSubscription.toJSON()
      const abo = daten.abo;
      if (!istObjekt(abo) || !istObjekt(abo.keys)) {
        return { ok: false, grund: "abo mit endpoint und keys fehlt" };
      }
      if (!endpunktOk(abo.endpoint)) {
        return { ok: false, grund: "endpoint ist kein bekannter Push-Dienst" };
      }
      // 65 Byte Schluessel und 16 Byte Geheimnis, base64url
      const p256dh = ohneAuffuellung(abo.keys.p256dh);
      const auth = ohneAuffuellung(abo.keys.auth);
      if (!istBase64url(p256dh, 87) || !istBase64url(auth, 22)) {
        return { ok: false, grund: "keys.p256dh oder keys.auth hat das falsche Format" };
      }
      return { ok: true, nachricht: { typ, abo: { endpoint: abo.endpoint, p256dh, auth } } };
    }
    case "push_abmelden": {
      if (typeof daten.endpoint !== "string" || daten.endpoint.length > 1024) {
        return { ok: false, grund: "endpoint fehlt" };
      }
      return { ok: true, nachricht: { typ, endpoint: daten.endpoint } };
    }
    case "push_test": {
      if (typeof daten.endpoint !== "string" || daten.endpoint.length > 1024) {
        return { ok: false, grund: "endpoint fehlt" };
      }
      const verzoegerung = daten.verzoegerung_s ?? 0;
      if (
        typeof verzoegerung !== "number" ||
        !Number.isInteger(verzoegerung) ||
        verzoegerung < 0 ||
        verzoegerung > MAX_TEST_VERZOEGERUNG_S
      ) {
        return {
          ok: false,
          grund: `verzoegerung_s muss 0 bis ${MAX_TEST_VERZOEGERUNG_S} sein`,
        };
      }
      return { ok: true, nachricht: { typ, endpoint: daten.endpoint, verzoegerung_s: verzoegerung } };
    }
  }
}
