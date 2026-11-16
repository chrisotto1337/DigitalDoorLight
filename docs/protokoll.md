# Nachrichten zwischen Display, Hub und App

Display und App sprechen nie direkt miteinander. Beide halten eine WebSocket-Verbindung
zum Hub, der Hub hält den Zustand und verteilt jede Änderung an alle.

## Verbindung

| Rolle | Adresse |
| --- | --- |
| Display | `wss://<hub>/ws/display?key=<DEVICE_KEY>` |
| App | `wss://<hub>/ws/app?key=<APP_KEY>` |

- Falscher Schlüssel: HTTP 401, die Verbindung kommt nicht zustande.
- Es gibt nur ein Display. Verbindet sich ein zweites, schließt der Hub das erste
  mit Code 4000.
- Lebenszeichen: Der Client schickt alle 30 Sekunden den Text `ping`, der Hub antwortet
  `pong`. Ohne Lebenszeichen für 75 Sekunden gilt das Display als offline.
- Nach dem Verbinden schickt der Hub sofort `status`, eine laufende `anfrage` und an die
  App zusätzlich `geraet`. Nach einem Neustart des Displays ist der Zustand damit
  sofort wieder da.

Alle anderen Nachrichten sind JSON-Objekte mit dem Feld `typ`. Zeiten sind Millisekunden
seit 1970 (Unix-Zeit), Farben sind `gruen`, `gelb` oder `rot`.

## Von der App an den Hub

| typ | Felder | Wirkung |
| --- | --- | --- |
| `status_setzen` | `farbe`, `dauer_s` (Sekunden oder `null`) | Setzt die Ampel. Mit `dauer_s` springt sie danach von selbst auf Grün. Bleibt die Farbe gleich, ändert sich nur die Dauer, `seit` bleibt stehen. |
| `antwort` | `id`, `ja` (`true` oder `false`) | Beantwortet die laufende Anfrage. |

## Vom Display an den Hub

| typ | Felder | Wirkung |
| --- | --- | --- |
| `anfrage` | keine | Startet eine Anfrage. Bei Grün lehnt der Hub ab. Läuft schon eine, bekommt das Display dieselbe noch einmal. |
| `abbruch` | `id` | Bricht die laufende Anfrage ab. |
| `geraet` | `strom` (`usb` oder `akku`), `akku_prozent` (0 bis 100 oder `null`) | Meldet die Stromversorgung. |

## Vom Hub an Display und App

| typ | Felder | Bedeutung |
| --- | --- | --- |
| `status` | `farbe`, `seit`, `bis` | Aktueller Stand der Ampel. `bis` ist `null`, wenn sie nicht von selbst zurückspringt. |
| `anfrage` | `id`, `start`, `frist`, `rest_ms` | Eine Anfrage läuft. `rest_ms` ist die Restzeit beim Senden, damit das Display keine Uhrzeit braucht. |
| `antwort` | `id`, `ja` | Die Anfrage wurde beantwortet. |
| `frist_abgelaufen` | `id` | Keine Antwort innerhalb der Frist, Standard 30 Sekunden. |
| `abbruch` | `id` | Das Display hat die Anfrage abgebrochen. |
| `geraet` | `online`, `zuletzt`, `strom`, `akku_prozent` | Nur an die App: Zustand des Displays. |
| `fehler` | `grund` | Nur an den Absender: Die Nachricht war ungültig oder nicht erlaubt. |

## Beispiel: eine Anfrage

```
Display → Hub   {"typ":"anfrage"}
Hub → alle      {"typ":"anfrage","id":"6f1c…","start":1794772306245,"frist":1794772336245,"rest_ms":30000}
App → Hub       {"typ":"antwort","id":"6f1c…","ja":true}
Hub → alle      {"typ":"antwort","id":"6f1c…","ja":true}
```

Die Ampel selbst ändert sich durch eine Antwort nicht. Das Display zeigt "Herein!" oder
"Jetzt nicht" kurz an und kehrt dann zum aktuellen Status zurück.
