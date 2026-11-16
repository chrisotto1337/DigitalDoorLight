import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";
import { NACHT_STANDARD, nachtStand, type NachtEinstellung } from "./nacht";
import {
  istFirmwareVersion,
  pruefeNachricht,
  type ClientNachricht,
  type Farbe,
  type HubNachricht,
  type Rolle,
  type Strom,
} from "./protocol";
import {
  aboErloschen,
  sendePush,
  vapidErzeugen,
  type PushAbo,
  type PushErgebnis,
  type PushOptionen,
  type VapidSchluessel,
} from "./webpush";

// Kopfzeile, ueber die der Worker die Rolle des Clients mitteilt.
export const ROLLEN_HEADER = "X-Tuerampel-Rolle";

const SPEICHER_SCHLUESSEL = "zustand";
const STANDARD_FRIST_S = 30;
// Ohne Lebenszeichen in dieser Zeit gilt das Display als offline.
const ONLINE_TIMEOUT_MS = 75_000;

const PUSH_SPEICHER = "push";
// Mehr Geraete braucht eine Tuer nicht. Das am laengsten stille fliegt zuerst raus.
const MAX_PUSH_ABOS = 10;
// Eine verpasste Anfrage ist auch Stunden spaeter noch interessant.
const VERPASST_TTL_S = 6 * 60 * 60;
// Gleiches Thema: eine noch nicht zugestellte Anfrage wird durch "verpasst" ersetzt.
const PUSH_THEMA = "anfrage";

const NACHT_SPEICHER = "nacht";
// Der Alarm zum Wechsel zwischen Tag und Nacht kommt knapp danach, nie davor.
const NACHT_ALARM_PUFFER_MS = 1000;

interface Zustand {
  status: { farbe: Farbe; seit: number; bis: number | null };
  anfrage: { id: string; start: number; frist: number } | null;
  geraet: {
    zuletzt: number | null;
    strom: Strom | null;
    akku_prozent: number | null;
    // Fehlt in Zustaenden von vor M7
    firmware?: string | null;
  };
}

interface PushZustand {
  vapid: VapidSchluessel | null;
  // Absenderadresse fuer den Push-Dienst, die Adresse des Hubs
  kontakt: string | null;
  abos: (PushAbo & { zuletzt: number })[];
}

// Haengt an jeder WebSocket-Verbindung und ueberlebt den Ruhezustand.
interface Verbindung {
  rolle: Rolle;
  verbunden: number;
  letzteNachricht: number;
}

function anfangsZustand(): Zustand {
  return {
    status: { farbe: "gruen", seit: Date.now(), bis: null },
    anfrage: null,
    geraet: { zuletzt: null, strom: null, akku_prozent: null, firmware: null },
  };
}

export class Door extends DurableObject<Env> {
  private zustand: Zustand = anfangsZustand();
  private push: PushZustand = { vapid: null, kontakt: null, abos: [] };
  private vapidLaeuft: Promise<VapidSchluessel> | null = null;
  private nacht: NachtEinstellung = { ...NACHT_STANDARD };
  // Zuletzt an alle gemeldet: Nacht ja oder nein. null nach einem Neustart.
  private nachtGemeldet: boolean | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // "ping" beantwortet die Laufzeit selbst, ohne das Objekt aufzuwecken.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      const gespeichert = await ctx.storage.get<Zustand>(SPEICHER_SCHLUESSEL);
      if (gespeichert) {
        this.zustand = gespeichert;
      }
      const push = await ctx.storage.get<PushZustand>(PUSH_SPEICHER);
      if (push) {
        this.push = push;
      }
      const nacht = await ctx.storage.get<NachtEinstellung>(NACHT_SPEICHER);
      if (nacht) {
        this.nacht = nacht;
      }
    });
  }

  // ---------- Verbindungsaufbau ----------

  async fetch(request: Request): Promise<Response> {
    const rolle = request.headers.get(ROLLEN_HEADER);
    if (rolle !== "display" && rolle !== "app") {
      return new Response("Rolle fehlt", { status: 400 });
    }

    await this.faelligesErledigen();

    const herkunft = new URL(request.url).origin;
    if (this.push.kontakt !== herkunft) {
      this.push.kontakt = herkunft;
      await this.pushSpeichern();
    }
    // Den Schluessel vorher holen, damit die Begruessung in einem Rutsch rausgeht
    const vapid = rolle === "app" ? await this.vapid() : null;

    const paar = new WebSocketPair();
    const [client, server] = Object.values(paar);
    const jetzt = Date.now();

    if (rolle === "display") {
      // Es gibt nur eine Tuer: eine aeltere Display-Verbindung wird ersetzt.
      for (const alt of this.ctx.getWebSockets("display")) {
        alt.close(4000, "Neue Display-Verbindung");
      }
    }

    this.ctx.acceptWebSocket(server, [rolle]);
    const verbindung: Verbindung = { rolle, verbunden: jetzt, letzteNachricht: jetzt };
    server.serializeAttachment(verbindung);

    this.senden(server, this.statusNachricht());
    const anfrage = this.anfrageNachricht();
    if (anfrage) {
      this.senden(server, anfrage);
    }
    this.senden(server, this.nachtNachricht(jetzt));

    if (rolle === "display") {
      const firmware = this.firmwareNachricht();
      if (firmware) {
        this.senden(server, firmware);
      }
      this.zustand.geraet.zuletzt = jetzt;
      await this.speichern();
      this.anRolle("app", this.geraetNachricht());
    } else {
      this.senden(server, { typ: "push_schluessel", schluessel: vapid!.oeffentlich });
      this.senden(server, this.geraetNachricht());
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- Eingehende Nachrichten ----------

  async webSocketMessage(ws: WebSocket, roh: string | ArrayBuffer): Promise<void> {
    const verbindung = ws.deserializeAttachment() as Verbindung | null;
    if (!verbindung) {
      ws.close(4001, "Verbindung unbekannt");
      return;
    }

    const jetzt = Date.now();
    verbindung.letzteNachricht = jetzt;
    ws.serializeAttachment(verbindung);

    await this.faelligesErledigen();

    const pruefung = pruefeNachricht(roh, verbindung.rolle, {
      lokalePushZiele: this.env.PUSH_LOKAL_ERLAUBT === "1",
    });
    if (!pruefung.ok) {
      this.senden(ws, { typ: "fehler", grund: pruefung.grund });
      return;
    }

    if (verbindung.rolle === "display") {
      this.zustand.geraet.zuletzt = jetzt;
    }

    await this.verarbeiten(ws, pruefung.nachricht, jetzt);
  }

  private async verarbeiten(ws: WebSocket, n: ClientNachricht, jetzt: number): Promise<void> {
    switch (n.typ) {
      case "status_setzen": {
        const alt = this.zustand.status;
        this.zustand.status = {
          farbe: n.farbe,
          // "seit" meint die Farbe: Aendert sich nur die Dauer, bleibt die Zeit stehen.
          seit: alt.farbe === n.farbe ? alt.seit : jetzt,
          bis: n.dauer_s === null || n.farbe === "gruen" ? null : jetzt + n.dauer_s * 1000,
        };
        await this.speichernUndPlanen();
        this.anAlle(this.statusNachricht());
        return;
      }

      case "anfrage": {
        if (this.zustand.status.farbe === "gruen") {
          this.senden(ws, { typ: "fehler", grund: "Bei Gruen ist keine Anfrage noetig" });
          return;
        }
        const laufend = this.anfrageNachricht();
        if (laufend) {
          // Doppelter Tipp: die laufende Anfrage gilt weiter.
          this.senden(ws, laufend);
          return;
        }
        this.zustand.anfrage = {
          id: crypto.randomUUID(),
          start: jetzt,
          frist: jetzt + this.fristMs(),
        };
        await this.speichernUndPlanen();
        this.anAlle(this.anfrageNachricht()!);
        const { id, start, frist } = this.zustand.anfrage;
        this.hintergrund(
          this.pushAnAlle(
            { art: "anfrage", id, start, frist },
            { ttlS: Math.ceil((frist - jetzt) / 1000), dringend: true, thema: PUSH_THEMA },
          ),
        );
        return;
      }

      case "antwort": {
        const anfrage = this.zustand.anfrage;
        if (!anfrage || anfrage.id !== n.id) {
          this.senden(ws, { typ: "fehler", grund: "Keine offene Anfrage mit dieser id" });
          return;
        }
        this.zustand.anfrage = null;
        await this.speichernUndPlanen();
        this.anAlle({ typ: "antwort", id: n.id, ja: n.ja });
        return;
      }

      case "abbruch": {
        const anfrage = this.zustand.anfrage;
        if (!anfrage || anfrage.id !== n.id) {
          this.senden(ws, { typ: "fehler", grund: "Keine offene Anfrage mit dieser id" });
          return;
        }
        this.zustand.anfrage = null;
        await this.speichernUndPlanen();
        this.anAlle({ typ: "abbruch", id: n.id });
        return;
      }

      case "geraet": {
        this.zustand.geraet.strom = n.strom;
        this.zustand.geraet.akku_prozent = n.akku_prozent;
        this.zustand.geraet.firmware = n.firmware;
        await this.speichern();
        this.anRolle("app", this.geraetNachricht());
        return;
      }

      case "nacht_setzen": {
        this.nacht = { an: n.an, von: n.von, bis: n.bis, zeitzone: n.zeitzone };
        await this.ctx.storage.put(NACHT_SPEICHER, this.nacht);
        await this.alarmPlanen();
        this.nachtGemeldet = nachtStand(this.nacht, jetzt).aktiv;
        this.anAlle(this.nachtNachricht(jetzt));
        return;
      }

      case "push_anmelden": {
        // Kommt bei jedem Verbindungsaufbau der App, haelt das Abo frisch.
        const abos = this.push.abos.filter((a) => a.endpoint !== n.abo.endpoint);
        abos.push({ ...n.abo, zuletzt: jetzt });
        abos.sort((a, b) => b.zuletzt - a.zuletzt);
        this.push.abos = abos.slice(0, MAX_PUSH_ABOS);
        await this.pushSpeichern();
        this.senden(ws, { typ: "push_status", endpoint: n.abo.endpoint, aktiv: true });
        return;
      }

      case "push_abmelden": {
        await this.abosEntfernen([n.endpoint]);
        this.senden(ws, { typ: "push_status", endpoint: n.endpoint, aktiv: false });
        return;
      }

      case "push_test": {
        const abo = this.push.abos.find((a) => a.endpoint === n.endpoint);
        if (!abo) {
          this.senden(ws, {
            typ: "push_ergebnis",
            ok: false,
            grund: "Dieses Geraet ist beim Hub nicht angemeldet",
          });
          return;
        }
        this.hintergrund(
          (async () => {
            if (n.verzoegerung_s > 0) {
              await new Promise((weiter) => setTimeout(weiter, n.verzoegerung_s * 1000));
            }
            const [ergebnis] = await this.pushSenden([abo], { art: "test" }, { ttlS: 60, dringend: true });
            this.senden(ws, {
              typ: "push_ergebnis",
              ok: ergebnis.grund === null,
              grund: ergebnis.grund === null ? null : `${ergebnis.status} ${ergebnis.grund}`,
            });
          })(),
        );
        return;
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const verbindung = ws.deserializeAttachment() as Verbindung | null;
    if (verbindung?.rolle === "display") {
      this.anRolle("app", this.geraetNachricht(ws));
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  // ---------- Fristen ----------

  async alarm(): Promise<void> {
    // Im Alarm immer neu planen: der laufende Alarm verfaellt nach diesem Aufruf.
    await this.faelligesErledigen(true);
  }

  // Erledigt abgelaufene Anfragen und abgelaufene Status-Dauern.
  // Laeuft im Alarm und vorsichtshalber bei jedem Ereignis.
  private async faelligesErledigen(imAlarm = false): Promise<void> {
    const jetzt = Date.now();
    const meldungen: HubNachricht[] = [];
    let verpasst: { id: string; start: number } | null = null;

    const anfrage = this.zustand.anfrage;
    if (anfrage && anfrage.frist <= jetzt) {
      this.zustand.anfrage = null;
      meldungen.push({ typ: "frist_abgelaufen", id: anfrage.id });
      verpasst = { id: anfrage.id, start: anfrage.start };
    }

    const status = this.zustand.status;
    if (status.bis !== null && status.bis <= jetzt) {
      this.zustand.status = { farbe: "gruen", seit: jetzt, bis: null };
      meldungen.push(this.statusNachricht());
    }

    if (meldungen.length > 0) {
      await this.speichern();
      for (const meldung of meldungen) {
        this.anAlle(meldung);
      }
    }

    // Tag und Nacht haben keinen gespeicherten Zustand, sie folgen der Uhr.
    const nacht = nachtStand(this.nacht, jetzt);
    if (nacht.aktiv !== this.nachtGemeldet) {
      this.nachtGemeldet = nacht.aktiv;
      this.anAlle(this.nachtNachricht(jetzt));
    }

    await this.alarmPlanen(imAlarm);

    if (verpasst) {
      const arbeit = this.pushAnAlle(
        { art: "verpasst", ...verpasst },
        { ttlS: VERPASST_TTL_S, dringend: false, thema: PUSH_THEMA },
      );
      // Im Alarm abwarten, sonst laeuft es neben der eigentlichen Nachricht her.
      if (imAlarm) await arbeit;
      else this.hintergrund(arbeit);
    }
  }

  private async alarmPlanen(erzwingen = false): Promise<void> {
    const wechsel = nachtStand(this.nacht, Date.now()).wechsel;
    const zeiten = [
      this.zustand.anfrage?.frist,
      this.zustand.status.bis ?? undefined,
      wechsel === null ? undefined : wechsel + NACHT_ALARM_PUFFER_MS,
    ].filter((zeit): zeit is number => zeit !== undefined);
    if (zeiten.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const naechste = Math.min(...zeiten);
    if (erzwingen || (await this.ctx.storage.getAlarm()) !== naechste) {
      await this.ctx.storage.setAlarm(naechste);
    }
  }

  private fristMs(): number {
    const sekunden = Number(this.env.ANFRAGE_FRIST_S);
    return (Number.isFinite(sekunden) && sekunden > 0 ? sekunden : STANDARD_FRIST_S) * 1000;
  }

  // ---------- Push ----------

  // Das Schluesselpaar entsteht beim ersten Bedarf und bleibt dann fuer immer.
  // Aendert es sich, muessen sich alle Geraete neu anmelden.
  private vapid(): Promise<VapidSchluessel> {
    if (this.push.vapid) {
      return Promise.resolve(this.push.vapid);
    }
    this.vapidLaeuft ??= (async () => {
      const neu = await vapidErzeugen();
      this.push.vapid = neu;
      await this.pushSpeichern();
      return neu;
    })().finally(() => {
      this.vapidLaeuft = null;
    });
    return this.vapidLaeuft;
  }

  private kontakt(): string {
    return this.push.kontakt ?? "mailto:tuerampel@example.com";
  }

  private async pushSenden(
    abos: PushAbo[],
    daten: Record<string, unknown>,
    optionen: PushOptionen,
  ): Promise<PushErgebnis[]> {
    const vapid = await this.vapid();
    const ergebnisse = await Promise.all(
      abos.map((abo) =>
        sendePush(abo, daten, vapid, this.kontakt(), optionen).catch(
          (fehler): PushErgebnis => ({ status: 0, grund: String(fehler) }),
        ),
      ),
    );
    ergebnisse.forEach((ergebnis, i) => {
      if (ergebnis.grund !== null) {
        console.warn(`Push an ${new URL(abos[i].endpoint).host}: ${ergebnis.status} ${ergebnis.grund}`);
      }
    });
    const erloschen = abos.filter((_, i) => aboErloschen(ergebnisse[i]));
    if (erloschen.length > 0) {
      await this.abosEntfernen(erloschen.map((a) => a.endpoint));
    }
    return ergebnisse;
  }

  private async pushAnAlle(daten: Record<string, unknown>, optionen: PushOptionen): Promise<void> {
    if (this.push.abos.length > 0) {
      await this.pushSenden([...this.push.abos], daten, optionen);
    }
  }

  private async abosEntfernen(endpunkte: string[]): Promise<void> {
    const vorher = this.push.abos.length;
    this.push.abos = this.push.abos.filter((a) => !endpunkte.includes(a.endpoint));
    if (this.push.abos.length !== vorher) {
      await this.pushSpeichern();
    }
  }

  // Arbeit, die nach der Antwort an die Clients weiterlaufen darf
  private hintergrund(arbeit: Promise<unknown>): void {
    this.ctx.waitUntil(
      arbeit.catch((fehler) => {
        console.error("Hintergrundarbeit fehlgeschlagen:", fehler);
      }),
    );
  }

  // ---------- Nachrichten bauen ----------

  private statusNachricht(): HubNachricht {
    const { farbe, seit, bis } = this.zustand.status;
    return { typ: "status", farbe, seit, bis };
  }

  private anfrageNachricht(): HubNachricht | null {
    const anfrage = this.zustand.anfrage;
    if (!anfrage) {
      return null;
    }
    const rest = Math.max(0, anfrage.frist - Date.now());
    return { typ: "anfrage", ...anfrage, rest_ms: rest };
  }

  private nachtNachricht(jetzt: number): HubNachricht {
    const { aktiv, wechsel } = nachtStand(this.nacht, jetzt);
    return { typ: "nacht", ...this.nacht, aktiv, wechsel };
  }

  // Nur wenn der Workflow beim Ausrollen eine gueltige Firmware mitgegeben hat
  private firmwareNachricht(): HubNachricht | null {
    const version = this.env.FIRMWARE_VERSION;
    const md5 = this.env.FIRMWARE_MD5;
    if (!istFirmwareVersion(version) || typeof md5 !== "string" || !/^[0-9a-f]{32}$/.test(md5)) {
      return null;
    }
    return { typ: "firmware", version, md5 };
  }

  // ohne: eine Verbindung, die gerade schliesst und nicht mehr zaehlt
  private geraetNachricht(ohne?: WebSocket): HubNachricht {
    const jetzt = Date.now();
    let online = false;
    let zuletzt = this.zustand.geraet.zuletzt;

    for (const ws of this.ctx.getWebSockets("display")) {
      if (ws === ohne || ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      const verbindung = ws.deserializeAttachment() as Verbindung | null;
      const ping = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      const aktiv = Math.max(verbindung?.letzteNachricht ?? 0, ping);
      zuletzt = Math.max(zuletzt ?? 0, aktiv);
      if (jetzt - aktiv < ONLINE_TIMEOUT_MS) {
        online = true;
      }
    }

    const { strom, akku_prozent } = this.zustand.geraet;
    const firmware = this.zustand.geraet.firmware ?? null;
    const firmware_neu = this.firmwareNachricht() ? this.env.FIRMWARE_VERSION! : null;
    return { typ: "geraet", online, zuletzt, strom, akku_prozent, firmware, firmware_neu };
  }

  // ---------- Senden und Speichern ----------

  private senden(ws: WebSocket, nachricht: HubNachricht): void {
    try {
      ws.send(JSON.stringify(nachricht));
    } catch {
      // Verbindung ist schon weg, webSocketClose raeumt auf.
    }
  }

  private anRolle(rolle: Rolle, nachricht: HubNachricht): void {
    for (const ws of this.ctx.getWebSockets(rolle)) {
      this.senden(ws, nachricht);
    }
  }

  private anAlle(nachricht: HubNachricht): void {
    for (const ws of this.ctx.getWebSockets()) {
      this.senden(ws, nachricht);
    }
  }

  private async speichern(): Promise<void> {
    await this.ctx.storage.put(SPEICHER_SCHLUESSEL, this.zustand);
  }

  private async pushSpeichern(): Promise<void> {
    await this.ctx.storage.put(PUSH_SPEICHER, this.push);
  }

  private async speichernUndPlanen(): Promise<void> {
    await this.speichern();
    await this.alarmPlanen();
  }
}
