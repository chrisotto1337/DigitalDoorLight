// Web Push ohne Fremdbibliothek, nur mit WebCrypto.
//   Verschluesselung: RFC 8291 (aes128gcm, RFC 8188)
//   Absenderkennung:  RFC 8292 (VAPID, JWT mit ES256)
// Laeuft im Worker und zum Testen in Node 22.

export interface PushAbo {
  endpoint: string;
  p256dh: string; // oeffentlicher Schluessel des Browsers, base64url
  auth: string; // Geheimnis des Browsers, base64url
}

export interface VapidSchluessel {
  privat: JsonWebKey;
  oeffentlich: string; // 65 Byte, unkomprimierter Punkt, base64url
}

export interface PushOptionen {
  ttlS: number; // wie lange der Push-Dienst zustellen soll
  dringend: boolean;
  thema?: string; // gleiches Thema ersetzt eine noch nicht zugestellte Nachricht
}

// ---------- base64url ----------

export function zuBase64url(daten: ArrayBuffer | Uint8Array): string {
  const bytes = daten instanceof Uint8Array ? daten : new Uint8Array(daten);
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function ausBase64url(text: string): Uint8Array {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  const auffuellen = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  const roh = atob(auffuellen);
  const bytes = new Uint8Array(roh.length);
  for (let i = 0; i < roh.length; i++) bytes[i] = roh.charCodeAt(i);
  return bytes;
}

function verbinde(...teile: Uint8Array[]): Uint8Array {
  const laenge = teile.reduce((summe, t) => summe + t.length, 0);
  const ergebnis = new Uint8Array(laenge);
  let pos = 0;
  for (const t of teile) {
    ergebnis.set(t, pos);
    pos += t.length;
  }
  return ergebnis;
}

const text = (s: string) => new TextEncoder().encode(s);

// ---------- VAPID-Schluessel ----------

// Apple bittet, den JWT hoechstens einmal pro Stunde zu erneuern.
// Er gilt 12 Stunden und wird nach 6 Stunden ersetzt.
const JWT_GUELTIG_S = 12 * 60 * 60;
const JWT_ERNEUERN_S = 6 * 60 * 60;

export async function vapidErzeugen(): Promise<VapidSchluessel> {
  const paar = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privat = (await crypto.subtle.exportKey("jwk", paar.privateKey)) as JsonWebKey;
  const oeffentlich = (await crypto.subtle.exportKey("raw", paar.publicKey)) as ArrayBuffer;
  return { privat, oeffentlich: zuBase64url(oeffentlich) };
}

async function vapidKopf(endpoint: string, schluessel: VapidSchluessel, kontakt: string): Promise<string> {
  const kopf = { typ: "JWT", alg: "ES256" };
  const inhalt = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + JWT_GUELTIG_S,
    sub: kontakt,
  };
  const unsigniert = `${zuBase64url(text(JSON.stringify(kopf)))}.${zuBase64url(text(JSON.stringify(inhalt)))}`;
  const privat = await crypto.subtle.importKey(
    "jwk",
    schluessel.privat,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // WebCrypto liefert r || s mit je 32 Byte, genau das Format von ES256.
  const signatur = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privat, text(unsigniert));
  return `vapid t=${unsigniert}.${zuBase64url(signatur)}, k=${schluessel.oeffentlich}`;
}

// ---------- Verschluesselung ----------

const MAX_NUTZLAST = 3000;

async function hkdf(salz: Uint8Array, material: Uint8Array, info: Uint8Array, laenge: number): Promise<Uint8Array> {
  const schluessel = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salz, info },
    schluessel,
    laenge * 8,
  );
  return new Uint8Array(bits);
}

export async function verschluesseln(nutzlast: Uint8Array, abo: PushAbo): Promise<Uint8Array> {
  const browserOeffentlich = ausBase64url(abo.p256dh);
  const authGeheimnis = ausBase64url(abo.auth);
  if (browserOeffentlich.length !== 65 || authGeheimnis.length !== 16) {
    throw new Error("Abo-Schluessel haben die falsche Laenge");
  }
  // Ein Datensatz von 4096 Byte reicht, Apple nimmt ohnehin hoechstens 4 KB.
  if (nutzlast.length > MAX_NUTZLAST) {
    throw new Error("Push-Inhalt zu gross");
  }

  // Einmal-Schluesselpaar des Absenders
  const einmal = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const einmalOeffentlich = new Uint8Array(
    (await crypto.subtle.exportKey("raw", einmal.publicKey)) as ArrayBuffer,
  );
  const browserSchluessel = await crypto.subtle.importKey(
    "raw",
    browserOeffentlich,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const gemeinsam = new Uint8Array(
    // Standardname des Feldes ist "public", die Worker-Typen nennen es "$public".
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: browserSchluessel } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      einmal.privateKey,
      256,
    ),
  );

  // RFC 8291, Abschnitt 3.4
  const schluesselInfo = verbinde(text("WebPush: info\0"), browserOeffentlich, einmalOeffentlich);
  const ikm = await hkdf(authGeheimnis, gemeinsam, schluesselInfo, 32);

  const salz = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salz, ikm, text("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salz, ikm, text("Content-Encoding: nonce\0"), 12);

  // Ein einziger Datensatz: Inhalt, dann 0x02 als Kennung "letzter Datensatz"
  const klartext = verbinde(nutzlast, new Uint8Array([2]));
  const aesSchluessel = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const geheim = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesSchluessel, klartext),
  );

  // Kopf nach RFC 8188: salt (16) | rs (4) | idlen (1) | keyid (65)
  const kopf = new Uint8Array(16 + 4 + 1 + 65);
  kopf.set(salz, 0);
  new DataView(kopf.buffer).setUint32(16, 4096);
  kopf[20] = 65;
  kopf.set(einmalOeffentlich, 21);
  return verbinde(kopf, geheim);
}

// ---------- Senden ----------

// Push-Dienste der grossen Browser. Andere Ziele nimmt der Hub nicht an.
const ERLAUBTE_DIENSTE = [
  ".push.apple.com",
  ".googleapis.com",
  ".push.services.mozilla.com",
  ".notify.windows.com",
];

// lokal: nur fuer Tests, erlaubt zusaetzlich http://127.0.0.1
export function erlaubterEndpunkt(endpoint: string, lokal = false): boolean {
  if (endpoint.length > 1024) return false;
  try {
    const url = new URL(endpoint);
    if (lokal && url.protocol === "http:" && url.hostname === "127.0.0.1") return true;
    return url.protocol === "https:" && ERLAUBTE_DIENSTE.some((d) => `.${url.hostname}`.endsWith(d));
  } catch {
    return false;
  }
}

export interface PushErgebnis {
  status: number; // 0, wenn der Push-Dienst nicht erreichbar war
  grund: string | null;
}

const jwtSpeicher = new Map<string, { kopf: string; erneuern: number; schluessel: string }>();

async function vapidKopfZwischengespeichert(
  endpoint: string,
  schluessel: VapidSchluessel,
  kontakt: string,
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const jetzt = Math.floor(Date.now() / 1000);
  const gespeichert = jwtSpeicher.get(aud);
  if (gespeichert && gespeichert.erneuern > jetzt && gespeichert.schluessel === schluessel.oeffentlich) {
    return gespeichert.kopf;
  }
  const kopf = await vapidKopf(endpoint, schluessel, kontakt);
  jwtSpeicher.set(aud, { kopf, erneuern: jetzt + JWT_ERNEUERN_S, schluessel: schluessel.oeffentlich });
  return kopf;
}

export async function sendePush(
  abo: PushAbo,
  daten: unknown,
  schluessel: VapidSchluessel,
  kontakt: string,
  optionen: PushOptionen,
): Promise<PushErgebnis> {
  const inhalt = await verschluesseln(text(JSON.stringify(daten)), abo);
  const kopf: Record<string, string> = {
    Authorization: await vapidKopfZwischengespeichert(abo.endpoint, schluessel, kontakt),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(Math.max(1, Math.round(optionen.ttlS))),
    Urgency: optionen.dringend ? "high" : "normal",
  };
  if (optionen.thema) kopf.Topic = optionen.thema;

  let antwort: Response;
  try {
    antwort = await fetch(abo.endpoint, {
      method: "POST",
      headers: kopf,
      body: inhalt,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (fehler) {
    return { status: 0, grund: fehler instanceof Error ? fehler.message : "nicht erreichbar" };
  }
  const rumpf = (await antwort.text().catch(() => "")).slice(0, 300);
  if (antwort.ok) return { status: antwort.status, grund: null };

  // Apple liefert {"reason": "..."}, andere Dienste meist Text
  let grund = rumpf || antwort.statusText || "unbekannt";
  try {
    const json = JSON.parse(rumpf) as { reason?: unknown; message?: unknown };
    if (typeof json.reason === "string") grund = json.reason;
    else if (typeof json.message === "string") grund = json.message;
  } catch {
    // kein JSON
  }
  return { status: antwort.status, grund };
}

// 404 und 410: das Abo gibt es beim Push-Dienst nicht mehr
export function aboErloschen(ergebnis: PushErgebnis): boolean {
  return ergebnis.status === 404 || ergebnis.status === 410;
}
