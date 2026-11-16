# Hub

Ein Cloudflare Worker mit einem Durable Object. Er hält den Zustand der Türampel,
verteilt Änderungen in Echtzeit an Display und App und überwacht die Fristen.
Die Nachrichten sind in [docs/protokoll.md](../docs/protokoll.md) beschrieben.

Der Hub liefert auch die App aus: Die Dateien in `public/` stellt Cloudflare unter
https://tuerampel-hub.chris-otto.workers.dev direkt bereit, ohne den Worker zu starten.

| Datei | Inhalt |
| --- | --- |
| `public/index.html` | Aufbau der App |
| `public/app.js` | Verbindung zum Hub, Anzeige, Hinweise bei Anfragen |
| `public/app.css` | Gestaltung, hell und dunkel |
| `public/sw.js` | Service Worker: schneller Start, Push-Mitteilungen, Tipp auf Mitteilung |
| `public/_headers` | Sicherheits-Header |
| `src/webpush.ts` | Web Push ohne Fremdbibliothek: Verschlüsselung und VAPID |

## Einmalige Einrichtung

Danach bringt GitHub jede Änderung an `hub/` auf `main` automatisch zu Cloudflare.
Alles geht im Browser, auch am iPhone. Für GitHub in Safari die Desktop-Ansicht
anfordern (Adressleiste, "aA").

### 1. Cloudflare-Konto

1. Auf [dash.cloudflare.com](https://dash.cloudflare.com) ein kostenloses Konto anlegen.
2. Links "Workers & Pages" öffnen. Beim ersten Mal fragt Cloudflare nach einer
   Subdomain für `workers.dev`. Einen Namen wählen, zum Beispiel `chrisotto`.
   Der Hub ist später unter `https://tuerampel-hub.<subdomain>.workers.dev` erreichbar.
3. Auf derselben Seite unter "Account Details" die **Account ID** kopieren.
4. Den Worker einmal von Hand anlegen: In "Workers & Pages" eine neue Anwendung
   erstellen, die Vorlage "Hello World" wählen, als Namen genau `tuerampel-hub`
   eintragen und bereitstellen. Der Grund: Ein Token aus der Vorlage
   "Edit Cloudflare Workers" darf vorhandene Worker aktualisieren, aber keine neuen
   anlegen. Der erste Lauf des Workflows ersetzt "Hello World" durch den Hub.

### 2. API-Token

1. Im Cloudflare-Dashboard die Seite "Account API tokens" öffnen und
   "Create Token" wählen.
2. Die Vorlage **Edit Cloudflare Workers** nehmen.
3. Prüfen, dass bei den Berechtigungen für Workers **Edit** (Editor) steht, nicht nur
   Read. Mit Leserechten scheitert das Ausrollen mit "No access to the specified resource".
4. Bei den Ressourcen nur das eigene Konto auswählen, dann "Continue to summary"
   und "Create Token".
5. Den Token kopieren. Cloudflare zeigt ihn nur einmal an.

### 3. Zwei Schlüssel erzeugen

Ein Schlüssel für das Display, einer für die App. Je 64 zufällige Zeichen aus 0 bis 9
und a bis f. Unter Windows in PowerShell, zweimal ausführen:

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RNGCryptoServiceProvider]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString("x2") }) -join ""
```

Beide Schlüssel im Passwort-Manager ablegen. Den App-Schlüssel gibst du später einmal
in der iPhone-App ein, den Display-Schlüssel bekommt ab M3 die Firmware.

### 4. GitHub-Secrets

Im Repository: Settings > Secrets and variables > Actions > "New repository secret".
Vier Einträge, die Namen genau so:

| Name | Inhalt |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Token aus Schritt 2 |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID aus Schritt 1 |
| `HUB_DEVICE_KEY` | Display-Schlüssel aus Schritt 3 |
| `HUB_APP_KEY` | App-Schlüssel aus Schritt 3 |

### 5. Ausrollen

Sobald die Änderung auf `main` liegt, läuft unter "Actions" der Workflow **Hub**:
erst die Tests, dann "Zu Cloudflare bringen". Zum Schluss prüft `test/live.mjs` den
ausgerollten Hub: Er antwortet, beide Schlüssel sind gesetzt, eine App-Verbindung
bekommt den Status. Der Zustand der Ampel bleibt dabei unverändert. Fehlt ein Secret, bricht der Workflow
mit einer Meldung ab, welches fehlt. Erneut starten geht unter Actions > Hub >
"Run workflow".

## Die App

1. Auf dem iPhone in Safari https://tuerampel-hub.chris-otto.workers.dev öffnen.
2. Teilen, dann "Zum Home-Bildschirm". Ab dann startet sie wie eine App.
3. Den App-Schlüssel einmal eingeben.

Am PC läuft dieselbe Adresse im Browser. Chrome und Edge bieten in der
Adressleiste an, sie als App zu installieren.

### Mitteilungen

Damit eine Anfrage auch bei geschlossener App ankommt:

1. Die App vom Home-Bildschirm öffnen. In Safari selbst bietet iOS keine Mitteilungen an.
2. Oben auf "Einschalten" tippen, dann "Erlauben". Alternativ unter Einstellungen,
   "Mitteilungen bei Anfrage".
3. Unter Einstellungen "Test-Mitteilung", "Senden" tippen und das iPhone sperren. Nach
   5 Sekunden kommt die Mitteilung.

Jedes Gerät meldet sich einzeln an, am PC genauso über den Browser. Eine Anfrage meldet
sich mit "Anfrage an der Tür", bleibt sie unbeantwortet, wird daraus "Verpasste Anfrage".
Ein eigener Ton geht mit Web Push nicht, es kommt der Standardton von iOS.

Kommt nichts an: In den iPhone-Einstellungen unter Mitteilungen, Türampel prüfen, ob
Mitteilungen erlaubt sind und der Fokus-Modus sie durchlässt. Fehlermeldungen des
Push-Dienstes stehen im Cloudflare-Dashboard unter Workers, tuerampel-hub, Logs.

### Nachtruhe

Unter Einstellungen, "Nachtruhe am Display": Von wann bis wann das Display dunkel
bleibt, standardmäßig 22 bis 7 Uhr. Die Uhrzeiten gelten an der Tür (Europe/Berlin),
auch wenn das Handy gerade in einer anderen Zeitzone ist. Oben zeigt die App dann
"Display schläft".

### Firmware

Der Workflow baut bei jedem Ausrollen die Firmware aus `firmware/` und legt sie als
`public/firmware/tuerampel.bin` zu den Dateien des Hubs. Ausgeliefert wird sie nur mit
Display-Schlüssel. Version und MD5-Summe setzt der Workflow als `FIRMWARE_VERSION` und
`FIRMWARE_MD5`. Unter Einstellungen, "Firmware" zeigt die App, was auf dem Display läuft.

## Ausprobieren

Die Testseite https://tuerampel-hub.chris-otto.workers.dev/test spielt App oder
Display. Zwei Tabs oder iPhone und Rechner nebeneinander:

1. Tab 1: Rolle "App", App-Schlüssel, Verbinden.
2. Tab 2: Rolle "Display simulieren", Display-Schlüssel, Verbinden.
3. In Tab 1 die Farbe wechseln: Tab 2 zeigt sie sofort.
4. Bei Gelb oder Rot in Tab 2 "Anfragen": Tab 1 zeigt die Anfrage mit Countdown.

## Lokal entwickeln

Braucht Node.js 22 oder neuer.

```
cd hub
npm install
cp .dev.vars.example .dev.vars
npm run dev        # Hub unter http://localhost:8787, Testseite unter /test
npm test           # Push-Verschlüsselung, dann Ablauftest gegen einen lokalen Hub
npm run typecheck
```

## Kosten

Der kostenlose Workers-Plan reicht. Er erlaubt Durable Objects mit SQLite-Speicher und
100.000 Anfragen pro Tag. Das Display schickt sein Lebenszeichen als `ping`, das die
Laufzeit selbst beantwortet, ohne den Hub zu wecken.
