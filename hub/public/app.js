// Türampel-App: steuert die Ampel und beantwortet Anfragen.
// Läuft auf dem iPhone (vom Home-Bildschirm) und im Browser am PC.
// Nachrichten: docs/protokoll.md

const $ = (id) => document.getElementById(id);

const NAMEN = { gruen: "Frei", gelb: "Bitte fragen", rot: "Nicht stören" };
const FRIST_MS = 30_000;
const PING_MS = 30_000;
const IST_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// ---------- Gespeicherte Einstellungen ----------

const speicher = {
  lies(name, vorgabe) {
    try {
      const wert = localStorage.getItem(`tuerampel.${name}`);
      return wert === null ? vorgabe : wert;
    } catch {
      return vorgabe;
    }
  },
  schreib(name, wert) {
    try {
      if (wert === null) localStorage.removeItem(`tuerampel.${name}`);
      else localStorage.setItem(`tuerampel.${name}`, String(wert));
    } catch {
      // Privater Modus ohne Speicher: dann gilt es nur bis zum Neuladen.
    }
  },
};

let schluessel = speicher.lies("schluessel", "");
let dauerS = Number(speicher.lies("dauer", "3600"));
let tonAn = speicher.lies("ton", "1") === "1";

// ---------- Zustand ----------

let status = null; // { farbe, seit, bis }
let geraet = null; // { online, ... }
let anfrage = null; // { id, endeLokal }
let verbunden = false;

// ---------- Kurze Meldung ----------

let meldungTimer = 0;
function melde(text) {
  const el = $("meldung");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(meldungTimer);
  meldungTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ---------- Zeiten ----------

function uhrzeit(ms) {
  return new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function dauerText(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "weniger als 1 Min";
  if (min < 60) return `${min} Min`;
  const std = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${std} Std` : `${std} Std ${rest} Min`;
}

function statusZeitText() {
  if (!status) return "";
  const jetzt = Date.now();
  const seit = jetzt - status.seit;
  let text = seit < 60_000 ? "Seit gerade eben" : seit < 12 * 3_600_000 ? `Seit ${dauerText(seit)}` : `Seit ${uhrzeit(status.seit)}`;
  if (status.bis) {
    text += `, Frei um ${uhrzeit(status.bis)}`;
  }
  return text;
}

// ---------- Anzeige ----------

function zeigeSeite(seite) {
  $("einrichtung").hidden = seite !== "einrichtung";
  $("haupt").hidden = seite !== "haupt";
}

function zeigeStatus() {
  const karte = $("statuskarte");
  karte.classList.remove("gruen", "gelb", "rot");
  if (status) {
    karte.classList.add(status.farbe);
    $("status-titel").textContent = NAMEN[status.farbe] ?? status.farbe;
    $("status-zeit").textContent = statusZeitText();
  } else {
    $("status-titel").textContent = "Unbekannt";
    $("status-zeit").textContent = "Warte auf den Hub";
  }
  for (const knopf of document.querySelectorAll(".farbe")) {
    knopf.setAttribute("aria-pressed", String(status?.farbe === knopf.dataset.farbe));
  }
}

function zeigeDauer() {
  for (const knopf of document.querySelectorAll(".dauer")) {
    knopf.setAttribute("aria-pressed", String(Number(knopf.dataset.dauer) === dauerS));
  }
}

function zeigeVerbindung() {
  const pille = $("display-pille");
  pille.classList.remove("online", "getrennt");
  if (!verbunden) {
    pille.classList.add("getrennt");
    $("display-text").textContent = "Keine Verbindung";
  } else if (geraet?.online) {
    pille.classList.add("online");
    $("display-text").textContent = "Display online";
  } else {
    $("display-text").textContent = "Display offline";
  }
  for (const knopf of document.querySelectorAll(".farbe, .dauer")) {
    knopf.disabled = !verbunden;
  }
}

// ---------- Hinweise bei einer Anfrage ----------

const hinweis = {
  audio: null,
  tonTimer: 0,
  titelTimer: 0,

  // Ein AudioContext darf erst nach einer Berührung starten.
  entsperren() {
    try {
      if (!this.audio || this.audio.state === "closed") {
        const Kontext = window.AudioContext || window.webkitAudioContext;
        if (!Kontext) return;
        this.audio = new Kontext();
      }
      if (this.audio.state === "suspended") this.audio.resume();
    } catch {
      this.audio = null;
    }
    $("ton-hinweis").hidden = true;
  },

  bereit() {
    return this.audio?.state === "running";
  },

  // Nach dem Wechsel in den Hintergrund ist der alte Kontext auf iOS oft stumm.
  verwerfen() {
    try {
      this.audio?.close();
    } catch {
      // egal
    }
    this.audio = null;
  },

  ton() {
    const ctx = this.audio;
    if (!ctx || ctx.state !== "running") return false;
    const start = ctx.currentTime + 0.02;
    [880, 660, 880, 660].forEach((frequenz, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequenz;
      const t = start + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.17);
    });
    return true;
  },

  async benachrichtigen() {
    if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const optionen = { body: "Jemand möchte rein", tag: "anfrage", requireInteraction: true, icon: "/icons/icon-192.png" };
      if (reg) await reg.showNotification("Anfrage an der Tür", optionen);
      else new Notification("Anfrage an der Tür", optionen);
    } catch {
      // Nicht jeder Browser kann das ohne Push.
    }
  },

  async benachrichtigungSchliessen() {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      for (const n of (await reg?.getNotifications({ tag: "anfrage" })) ?? []) n.close();
    } catch {
      // egal
    }
  },

  start() {
    if (tonAn) {
      this.ton();
      this.tonTimer = setInterval(() => this.ton(), 6000);
    }
    navigator.vibrate?.([200, 100, 200]);
    navigator.setAppBadge?.(1).catch(() => {});
    const titel = ["Anfrage an der Tür", "Türampel"];
    let i = 0;
    document.title = titel[0];
    this.titelTimer = setInterval(() => (document.title = titel[++i % 2]), 1000);
    this.benachrichtigen();
  },

  stop() {
    clearInterval(this.tonTimer);
    clearInterval(this.titelTimer);
    document.title = "Türampel";
    navigator.clearAppBadge?.().catch(() => {});
    this.benachrichtigungSchliessen();
  },
};

// ---------- Anfrage-Ansicht ----------

let restTimer = 0;

function zeigeRest() {
  if (!anfrage) return;
  const rest = Math.max(0, anfrage.endeLokal - Date.now());
  $("anfrage-balken").style.width = `${(rest / FRIST_MS) * 100}%`;
  const s = Math.ceil(rest / 1000);
  $("anfrage-rest").textContent = s === 1 ? "Noch 1 Sekunde" : `Noch ${s} Sekunden`;
}

function anfrageOeffnen(n) {
  const neu = !anfrage || anfrage.id !== n.id;
  anfrage = { id: n.id, endeLokal: Date.now() + n.rest_ms };
  $("anfrage-info").textContent = status ? `Status ist ${NAMEN[status.farbe]}` : "";
  $("anfrage").hidden = false;
  zeigeRest();
  clearInterval(restTimer);
  restTimer = setInterval(zeigeRest, 250);
  if (neu) {
    hinweis.start();
    $("antwort-ja").focus();
  }
}

function anfrageSchliessen(meldung) {
  if (!anfrage) return;
  anfrage = null;
  clearInterval(restTimer);
  hinweis.stop();
  $("anfrage").hidden = true;
  if (meldung) melde(meldung);
}

function antworten(ja) {
  if (!anfrage) return;
  if (sende({ typ: "antwort", id: anfrage.id, ja })) {
    anfrageSchliessen(ja ? "Du hast hereingebeten" : "Du hast abgelehnt");
  }
}

// ---------- Verbindung zum Hub ----------

let ws = null;
let pingTimer = 0;
let neuTimer = 0;
let fehlversuche = 0;
let letzteNachricht = 0;

function sende(nachricht) {
  if (ws?.readyState !== WebSocket.OPEN) {
    melde("Keine Verbindung zum Hub");
    return false;
  }
  ws.send(JSON.stringify(nachricht));
  return true;
}

function empfange(text) {
  letzteNachricht = Date.now();
  if (text === "pong") return;
  let n;
  try {
    n = JSON.parse(text);
  } catch {
    return;
  }
  switch (n.typ) {
    case "status":
      status = { farbe: n.farbe, seit: n.seit, bis: n.bis };
      zeigeStatus();
      break;
    case "geraet":
      geraet = n;
      zeigeVerbindung();
      break;
    case "anfrage":
      anfrageOeffnen(n);
      break;
    case "antwort":
      if (anfrage?.id === n.id) anfrageSchliessen(n.ja ? "Beantwortet: Herein" : "Beantwortet: Jetzt nicht");
      break;
    case "frist_abgelaufen":
      if (anfrage?.id === n.id) anfrageSchliessen("Anfrage ohne Antwort abgelaufen");
      break;
    case "abbruch":
      if (anfrage?.id === n.id) anfrageSchliessen("Anfrage an der Tür abgebrochen");
      break;
    case "fehler":
      melde(`Hub: ${n.grund}`);
      break;
  }
}

// Fragt den Hub ohne WebSocket, ob der Schlüssel stimmt: 426 ja, 401 nein.
async function pruefeSchluessel(kandidat) {
  try {
    const r = await fetch(`/ws/app?key=${encodeURIComponent(kandidat)}`, { cache: "no-store" });
    if (r.status === 426) return "ok";
    if (r.status === 401) return "falsch";
    return "fehler";
  } catch {
    return "fehler";
  }
}

function setzeVerbunden(wert) {
  verbunden = wert;
  $("verbindung-hinweis").hidden = wert;
  zeigeVerbindung();
}

function verbinden() {
  clearTimeout(neuTimer);
  if (!schluessel || ws) return;
  const adresse = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/app?key=${encodeURIComponent(schluessel)}`;
  const socket = new WebSocket(adresse);
  ws = socket;

  socket.onopen = () => {
    fehlversuche = 0;
    letzteNachricht = Date.now();
    setzeVerbunden(true);
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (Date.now() - letzteNachricht > PING_MS * 2.5) {
        socket.close();
        return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.send("ping");
    }, PING_MS);
  };
  socket.onmessage = (e) => empfange(String(e.data));
  socket.onclose = async () => {
    if (ws !== socket) return;
    ws = null;
    clearInterval(pingTimer);
    setzeVerbunden(false);
    if (anfrage) anfrageSchliessen();
    fehlversuche++;
    // Mehrmals hintereinander gescheitert: vielleicht stimmt der Schlüssel nicht mehr.
    if (fehlversuche === 3 && (await pruefeSchluessel(schluessel)) === "falsch") {
      abmelden("Der App-Schlüssel stimmt nicht mehr. Bitte neu eingeben.");
      return;
    }
    const warte = Math.min(10_000, 1000 * 2 ** Math.min(fehlversuche - 1, 4));
    neuTimer = setTimeout(verbinden, warte);
  };
}

function trennen() {
  clearTimeout(neuTimer);
  clearInterval(pingTimer);
  const socket = ws;
  ws = null;
  socket?.close();
  setzeVerbunden(false);
}

// Holt die Verbindung zurück, wenn die App wieder sichtbar wird.
function aufwachen() {
  if (!schluessel) return;
  if (!ws) {
    fehlversuche = 0;
    verbinden();
  } else if (ws.readyState === WebSocket.OPEN) {
    // Auf dem iPhone kann die Verbindung im Hintergrund still gestorben sein.
    const vorher = letzteNachricht;
    ws.send("ping");
    setTimeout(() => {
      if (ws && letzteNachricht === vorher) ws.close();
    }, 4000);
  }
}

// ---------- Anmelden ----------

function abmelden(fehlertext) {
  trennen();
  anfrageSchliessen();
  schluessel = "";
  speicher.schreib("schluessel", null);
  status = null;
  geraet = null;
  zeigeSeite("einrichtung");
  const fehler = $("schluessel-fehler");
  fehler.textContent = fehlertext ?? "";
  fehler.hidden = !fehlertext;
  $("schluessel").value = "";
  $("schluessel").focus();
}

async function anmelden(e) {
  e.preventDefault();
  const kandidat = $("schluessel").value.trim();
  const fehler = $("schluessel-fehler");
  if (!kandidat) {
    fehler.textContent = "Bitte den Schlüssel eingeben.";
    fehler.hidden = false;
    return;
  }
  const ergebnis = await pruefeSchluessel(kandidat);
  if (ergebnis !== "ok") {
    fehler.textContent = ergebnis === "falsch" ? "Der Schlüssel stimmt nicht." : "Der Hub ist gerade nicht erreichbar.";
    fehler.hidden = false;
    return;
  }
  fehler.hidden = true;
  schluessel = kandidat;
  speicher.schreib("schluessel", kandidat);
  starteHaupt();
}

function starteHaupt() {
  zeigeSeite("haupt");
  $("ton-hinweis").hidden = !tonAn || hinweis.bereit();
  zeigeStatus();
  zeigeDauer();
  zeigeVerbindung();
  verbinden();
}

// ---------- Einstellungen ----------

function zeigeBenachrichtigung() {
  const knopf = $("benachrichtigung");
  const info = $("benachrichtigung-info");
  if (!("Notification" in window)) {
    knopf.hidden = true;
    info.textContent = "In diesem Browser nicht verfügbar. Auf dem iPhone kommt das mit den Push-Mitteilungen.";
    return;
  }
  const erlaubt = Notification.permission === "granted";
  const verboten = Notification.permission === "denied";
  knopf.textContent = erlaubt ? "Erlaubt" : "Erlauben";
  knopf.disabled = erlaubt || verboten;
  info.textContent = verboten
    ? "Im Browser blockiert. Freigeben kannst du sie in den Website-Einstellungen."
    : "Erscheint, wenn die App im Hintergrund offen ist, etwa in einem anderen Tab am PC.";
}

// ---------- Start ----------

function einrichten() {
  $("schluessel-form").addEventListener("submit", anmelden);

  for (const knopf of document.querySelectorAll(".farbe")) {
    knopf.addEventListener("click", () => {
      const farbe = knopf.dataset.farbe;
      sende({ typ: "status_setzen", farbe, dauer_s: farbe === "gruen" || dauerS === 0 ? null : dauerS });
    });
  }

  for (const knopf of document.querySelectorAll(".dauer")) {
    knopf.addEventListener("click", () => {
      dauerS = Number(knopf.dataset.dauer);
      speicher.schreib("dauer", dauerS);
      zeigeDauer();
      // Gilt sofort, wenn gerade Gelb oder Rot gesetzt ist.
      if (status && status.farbe !== "gruen") {
        sende({ typ: "status_setzen", farbe: status.farbe, dauer_s: dauerS === 0 ? null : dauerS });
      }
    });
  }

  $("antwort-ja").addEventListener("click", () => antworten(true));
  $("antwort-nein").addEventListener("click", () => antworten(false));

  $("ton-an").checked = tonAn;
  $("ton-an").addEventListener("change", (e) => {
    tonAn = e.target.checked;
    speicher.schreib("ton", tonAn ? "1" : "0");
    $("ton-hinweis").hidden = !tonAn || hinweis.bereit();
  });
  $("ton-test").addEventListener("click", () => {
    hinweis.entsperren();
    // Der Kontext startet asynchron, kurz warten.
    setTimeout(() => {
      if (!hinweis.ton()) melde("Ton gerade nicht möglich. Ist das Gerät stumm geschaltet?");
    }, 120);
  });

  $("benachrichtigung").addEventListener("click", async () => {
    try {
      await Notification.requestPermission();
    } catch {
      // egal
    }
    zeigeBenachrichtigung();
  });
  zeigeBenachrichtigung();

  $("abmelden").addEventListener("click", () => abmelden());

  // Jede Berührung entsperrt den Ton für spätere Anfragen.
  document.addEventListener("pointerdown", () => hinweis.entsperren(), { passive: true });
  document.addEventListener("keydown", () => hinweis.entsperren());

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      aufwachen();
      if (tonAn && !hinweis.bereit()) $("ton-hinweis").hidden = false;
    } else if (IST_IOS) {
      // Am PC spielt der Ton auch im Hintergrund-Tab, auf dem iPhone nicht.
      hinweis.verwerfen();
    }
  });
  window.addEventListener("online", aufwachen);

  // Zeiten in der Statuskarte aktuell halten
  setInterval(() => status && ($("status-zeit").textContent = statusZeitText()), 30_000);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  if (schluessel) starteHaupt();
  else zeigeSeite("einrichtung");
}

einrichten();
