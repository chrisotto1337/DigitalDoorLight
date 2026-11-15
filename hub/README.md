# Hub

Ein Cloudflare Worker mit einem Durable Object. Er hält den Zustand der Türampel,
verteilt Änderungen in Echtzeit an Display und App und überwacht die Fristen.
Die Nachrichten sind in [docs/protokoll.md](../docs/protokoll.md) beschrieben.

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

### 2. API-Token

1. Im Cloudflare-Dashboard die Seite "Account API tokens" öffnen und
   "Create Token" wählen.
2. Die Vorlage **Edit Cloudflare Workers** nehmen.
3. Bei den Ressourcen nur das eigene Konto auswählen, dann "Continue to summary"
   und "Create Token".
4. Den Token kopieren. Cloudflare zeigt ihn nur einmal an.

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
erst die Tests, dann "Zu Cloudflare bringen". Fehlt ein Secret, bricht der Workflow
mit einer Meldung ab, welches fehlt. Erneut starten geht unter Actions > Hub >
"Run workflow".

## Ausprobieren

Die Testseite `https://tuerampel-hub.<subdomain>.workers.dev/test` spielt App oder
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
npm test           # Ablauftest gegen einen lokalen Hub
npm run typecheck
```

## Kosten

Der kostenlose Workers-Plan reicht. Er erlaubt Durable Objects mit SQLite-Speicher und
100.000 Anfragen pro Tag. Das Display schickt sein Lebenszeichen als `ping`, das die
Laufzeit selbst beantwortet, ohne den Hub zu wecken.
