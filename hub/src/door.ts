import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";
import {
  pruefeNachricht,
  type ClientNachricht,
  type Farbe,
  type HubNachricht,
  type Rolle,
  type Strom,
} from "./protocol";

// Kopfzeile, ueber die der Worker die Rolle des Clients mitteilt.
export const ROLLEN_HEADER = "X-Tuerampel-Rolle";

const SPEICHER_SCHLUESSEL = "zustand";
const STANDARD_FRIST_S = 30;
// Ohne Lebenszeichen in dieser Zeit gilt das Display als offline.
const ONLINE_TIMEOUT_MS = 75_000;

interface Zustand {
  status: { farbe: Farbe; seit: number; bis: number | null };
  anfrage: { id: string; start: number; frist: number } | null;
  geraet: { zuletzt: number | null; strom: Strom | null; akku_prozent: number | null };
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
    geraet: { zuletzt: null, strom: null, akku_prozent: null },
  };
}

export class Door extends DurableObject<Env> {
  private zustand: Zustand = anfangsZustand();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // "ping" beantwortet die Laufzeit selbst, ohne das Objekt aufzuwecken.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      const gespeichert = await ctx.storage.get<Zustand>(SPEICHER_SCHLUESSEL);
      if (gespeichert) {
        this.zustand = gespeichert;
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

    if (rolle === "display") {
      this.zustand.geraet.zuletzt = jetzt;
      await this.speichern();
      this.anRolle("app", this.geraetNachricht());
    } else {
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

    const pruefung = pruefeNachricht(roh, verbindung.rolle);
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
        await this.speichern();
        this.anRolle("app", this.geraetNachricht());
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

    const anfrage = this.zustand.anfrage;
    if (anfrage && anfrage.frist <= jetzt) {
      this.zustand.anfrage = null;
      meldungen.push({ typ: "frist_abgelaufen", id: anfrage.id });
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
    await this.alarmPlanen(imAlarm);
  }

  private async alarmPlanen(erzwingen = false): Promise<void> {
    const zeiten = [this.zustand.anfrage?.frist, this.zustand.status.bis ?? undefined].filter(
      (zeit): zeit is number => zeit !== undefined,
    );
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
    return { typ: "geraet", online, zuletzt, strom, akku_prozent };
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

  private async speichernUndPlanen(): Promise<void> {
    await this.speichern();
    await this.alarmPlanen();
  }
}
