// Testseite unter /test: spielt App oder Display, um den Hub ohne Hardware zu pruefen.
// Zwei Tabs oder zwei Geraete mit dieser Seite reichen fuer den Test aus M2.

export const TESTSEITE_HTML = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Türampel-Hub: Testseite</title>
<style>
  :root { color-scheme: light dark; --rand: #8883; }
  [hidden] { display: none !important; }
  body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 560px; padding: 16px; line-height: 1.4; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  section { border: 1px solid var(--rand); border-radius: 12px; padding: 12px 14px; margin: 12px 0; }
  h2 { font-size: 15px; margin: 0 0 8px; }
  label { display: block; font-size: 14px; margin: 6px 0 2px; }
  input, select, button { font: inherit; font-size: 16px; }
  input, select { width: 100%; box-sizing: border-box; padding: 8px; border-radius: 8px; border: 1px solid var(--rand); }
  button { padding: 10px 14px; border-radius: 10px; border: 1px solid var(--rand); background: transparent; cursor: pointer; min-height: 44px; }
  button:disabled { opacity: .45; cursor: default; }
  .reihe { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .reihe > * { flex: 1 1 auto; }
  .ampel { display: flex; align-items: center; gap: 14px; }
  .punkt { width: 56px; height: 56px; border-radius: 50%; background: #8886; flex: none; }
  .gruen { background: #19A654; } .gelb { background: #F5B800; } .rot { background: #E5372C; }
  .gross { font-size: 22px; font-weight: 600; }
  .klein { font-size: 14px; opacity: .75; }
  #log { font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 260px; overflow: auto; margin: 0; }
</style>
</head>
<body>
<h1>Türampel-Hub: Testseite</h1>

<section>
  <h2>Verbindung</h2>
  <label for="rolle">Rolle</label>
  <select id="rolle">
    <option value="app">App (iPhone)</option>
    <option value="display">Display simulieren</option>
  </select>
  <label for="schluessel">Schlüssel</label>
  <input id="schluessel" type="password" autocomplete="off" spellcheck="false">
  <div class="reihe">
    <button id="verbinden" type="button">Verbinden</button>
  </div>
  <p id="verbindung" class="klein">Nicht verbunden</p>
</section>

<section>
  <h2>Ampel</h2>
  <div class="ampel">
    <div id="punkt" class="punkt"></div>
    <div>
      <div id="farbe" class="gross">unbekannt</div>
      <div id="statusinfo" class="klein"></div>
    </div>
  </div>
  <div id="appsteuerung" class="reihe">
    <label for="dauer" style="flex-basis:100%">Automatisch zurück auf Grün</label>
    <select id="dauer" style="flex-basis:100%">
      <option value="">Aus</option>
      <option value="60">nach 1 Minute</option>
      <option value="1800">nach 30 Minuten</option>
      <option value="3600">nach 1 Stunde</option>
      <option value="7200">nach 2 Stunden</option>
    </select>
    <button type="button" data-farbe="gruen">Frei</button>
    <button type="button" data-farbe="gelb">Bitte fragen</button>
    <button type="button" data-farbe="rot">Nicht stören</button>
  </div>
</section>

<section>
  <h2>Anfrage</h2>
  <p id="anfrage">Keine Anfrage</p>
  <div class="reihe">
    <button id="ja" type="button" data-nur="app" disabled>Ja, herein</button>
    <button id="nein" type="button" data-nur="app" disabled>Jetzt nicht</button>
    <button id="anfragen" type="button" data-nur="display" disabled>Anfragen</button>
    <button id="abbrechen" type="button" data-nur="display" disabled>Abbrechen</button>
  </div>
</section>

<section id="geraetbereich">
  <h2>Display</h2>
  <p id="geraet">unbekannt</p>
  <div class="reihe" data-nur="display">
    <button id="usb" type="button">Meldet: USB</button>
    <button id="akku" type="button">Meldet: Akku 40 %</button>
  </div>
</section>

<section>
  <h2>Nachrichten</h2>
  <pre id="log"></pre>
</section>

<script src="/test.js"></script>
</body>
</html>
`;

export const TESTSEITE_JS = `"use strict";
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var NAMEN = { gruen: "Frei", gelb: "Bitte fragen", rot: "Nicht stören" };

  var ws = null;
  var pingTimer = null;
  var uhrTimer = null;
  var anfrage = null;      // { id, endeLokal }
  var antwortEnde = null;  // Text der letzten Antwort

  function rolle() { return $("rolle").value; }

  function merke(schluessel, wert) {
    try { localStorage.setItem(schluessel, wert); } catch (e) {}
  }
  function lies(schluessel) {
    try { return localStorage.getItem(schluessel) || ""; } catch (e) { return ""; }
  }

  function zeit(ms) {
    return new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function log(richtung, text) {
    var zeile = zeit(Date.now()) + " " + richtung + " " + text + "\\n";
    var el = $("log");
    el.textContent = (zeile + el.textContent).split("\\n").slice(0, 80).join("\\n");
  }

  function rollenAnsicht() {
    var r = rolle();
    var nurElemente = document.querySelectorAll("[data-nur]");
    for (var i = 0; i < nurElemente.length; i++) {
      nurElemente[i].hidden = nurElemente[i].getAttribute("data-nur") !== r;
    }
    $("appsteuerung").hidden = r !== "app";
    $("geraet").textContent = r === "app" ? "unbekannt" : "Diese Seite spielt das Display.";
    $("schluessel").value = lies("schluessel_" + r);
  }

  function verbunden() { return ws && ws.readyState === WebSocket.OPEN; }

  function knoepfe() {
    var offen = verbunden();
    var app = rolle() === "app";
    var steuer = $("appsteuerung").querySelectorAll("button");
    for (var i = 0; i < steuer.length; i++) steuer[i].disabled = !offen;
    $("ja").disabled = !(offen && app && anfrage);
    $("nein").disabled = !(offen && app && anfrage);
    $("anfragen").disabled = !(offen && !app && !anfrage);
    $("abbrechen").disabled = !(offen && !app && anfrage);
    $("usb").disabled = !offen;
    $("akku").disabled = !offen;
    $("verbinden").textContent = ws ? "Trennen" : "Verbinden";
    $("rolle").disabled = !!ws;
  }

  function senden(nachricht) {
    if (!verbunden()) return;
    var text = JSON.stringify(nachricht);
    ws.send(text);
    log("→", text);
  }

  function anfrageAnzeigen() {
    if (anfrage) {
      var rest = Math.max(0, Math.ceil((anfrage.endeLokal - Date.now()) / 1000));
      $("anfrage").textContent = "Anfrage läuft, noch " + rest + " Sekunden";
    } else {
      $("anfrage").textContent = antwortEnde || "Keine Anfrage";
    }
    knoepfe();
  }

  function empfangen(text) {
    log("←", text);
    if (text === "pong") return;
    var n;
    try { n = JSON.parse(text); } catch (e) { return; }

    if (n.typ === "status") {
      $("punkt").className = "punkt " + n.farbe;
      $("farbe").textContent = NAMEN[n.farbe] || n.farbe;
      $("statusinfo").textContent = "seit " + zeit(n.seit) + (n.bis ? ", bis " + zeit(n.bis) : "");
    } else if (n.typ === "anfrage") {
      anfrage = { id: n.id, endeLokal: Date.now() + n.rest_ms };
      antwortEnde = null;
    } else if (n.typ === "antwort") {
      anfrage = null;
      antwortEnde = n.ja ? "Antwort: Ja, herein" : "Antwort: Jetzt nicht";
    } else if (n.typ === "frist_abgelaufen") {
      anfrage = null;
      antwortEnde = "Keine Antwort, Frist abgelaufen";
    } else if (n.typ === "abbruch") {
      anfrage = null;
      antwortEnde = "Anfrage abgebrochen";
    } else if (n.typ === "geraet" && rolle() === "app") {
      var teile = [n.online ? "online" : "offline"];
      if (n.strom) teile.push(n.strom === "usb" ? "USB" : "Akku");
      if (n.akku_prozent !== null) teile.push(n.akku_prozent + " %");
      if (n.zuletzt) teile.push("zuletzt " + zeit(n.zuletzt));
      $("geraet").textContent = teile.join(", ");
    }
    anfrageAnzeigen();
  }

  function trennen() {
    if (ws) { ws.onclose = null; ws.close(); }
    ws = null;
    anfrage = null;
    clearInterval(pingTimer);
    clearInterval(uhrTimer);
    $("verbindung").textContent = "Nicht verbunden";
    knoepfe();
  }

  function verbinden() {
    var r = rolle();
    var schluessel = $("schluessel").value.trim();
    if (!schluessel) {
      $("verbindung").textContent = "Bitte den Schlüssel eingeben";
      return;
    }
    merke("schluessel_" + r, schluessel);

    var protokoll = location.protocol === "https:" ? "wss:" : "ws:";
    var adresse = protokoll + "//" + location.host + "/ws/" + r + "?key=" + encodeURIComponent(schluessel);
    $("verbindung").textContent = "Verbinde …";
    ws = new WebSocket(adresse);
    knoepfe();

    ws.onopen = function () {
      $("verbindung").textContent = "Verbunden als " + (r === "app" ? "App" : "Display");
      pingTimer = setInterval(function () { if (verbunden()) ws.send("ping"); }, 30000);
      uhrTimer = setInterval(anfrageAnzeigen, 500);
      knoepfe();
    };
    ws.onmessage = function (e) { empfangen(String(e.data)); };
    ws.onclose = function (e) {
      log("×", "Verbindung beendet (" + e.code + ")");
      trennen();
      $("verbindung").textContent = e.code === 1006
        ? "Verbindung fehlgeschlagen. Stimmt der Schlüssel?"
        : "Verbindung beendet";
    };
  }

  $("rolle").addEventListener("change", rollenAnsicht);
  $("verbinden").addEventListener("click", function () { ws ? trennen() : verbinden(); });

  var farbKnoepfe = $("appsteuerung").querySelectorAll("button[data-farbe]");
  for (var i = 0; i < farbKnoepfe.length; i++) {
    farbKnoepfe[i].addEventListener("click", function (e) {
      var dauer = $("dauer").value;
      senden({ typ: "status_setzen", farbe: e.currentTarget.getAttribute("data-farbe"), dauer_s: dauer ? Number(dauer) : null });
    });
  }
  $("ja").addEventListener("click", function () { if (anfrage) senden({ typ: "antwort", id: anfrage.id, ja: true }); });
  $("nein").addEventListener("click", function () { if (anfrage) senden({ typ: "antwort", id: anfrage.id, ja: false }); });
  $("anfragen").addEventListener("click", function () { senden({ typ: "anfrage" }); });
  $("abbrechen").addEventListener("click", function () { if (anfrage) senden({ typ: "abbruch", id: anfrage.id }); });
  $("usb").addEventListener("click", function () { senden({ typ: "geraet", strom: "usb", akku_prozent: null }); });
  $("akku").addEventListener("click", function () { senden({ typ: "geraet", strom: "akku", akku_prozent: 40 }); });

  rollenAnsicht();
  knoepfe();
})();
`;
