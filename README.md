# DigitalDoorLight

Eine Türampel: Ein LILYGO T-Display S3 AMOLED an der Tür zeigt Grün, Gelb oder Rot.
Gesteuert wird es vom iPhone. Wer vor der Tür steht, kann per Tipp auf das Display
anfragen, ob er rein darf.

## Stand

Meilenstein 1 von 8 ist erledigt: Das Display zeigt alle sechs Zustände, noch ohne WLAN und App.
Meilenstein 2 ist erledigt: Der Hub läuft unter
https://tuerampel-hub.chris-otto.workers.dev, die Testseite unter `/test`.
Einrichtung und Betrieb: [hub/README.md](hub/README.md).

![Die sechs Screens](docs/m1-screens.png)

Das Bild stammt aus einem Rendering des Firmware-Codes am Rechner. Am Gerät
getestet am 15.11.2026: Anzeige, Tipp und Countdown laufen.

| Nr. | Ziel | Stand |
| --- | --- | --- |
| M1 | Display zeigt alle Zustände | erledigt |
| M2 | Cloud-Hub steht | erledigt |
| M3 | Display hängt am Hub | offen |
| M4 | iPhone-App steuert die Ampel | offen |
| M5 | Anfrage bei offener App | offen |
| M6 | Push-Mitteilung | offen |
| M7 | Dauerbetrieb an der Tür | offen |
| M8 | Akku als Puffer | offen |

## Hardware

- LILYGO T-Display S3 AMOLED, 1,91 Zoll, 240 x 536 Pixel, Touch-Version
- USB-C-Kabel mit Datenleitung

## Firmware aufspielen

1. [VS Code](https://code.visualstudio.com) installieren, darin die Erweiterung
   "PlatformIO IDE".
2. Dieses Repository klonen und in VS Code den Ordner `firmware` öffnen, nicht das
   Hauptverzeichnis.
3. Das Board per USB-C anschließen.
4. In der PlatformIO-Leiste unten auf den Pfeil "Upload" klicken. Der erste Lauf
   lädt Compiler und Bibliotheken und dauert einige Minuten.

Auf der Kommandozeile geht dasselbe mit `pio run -t upload` im Ordner `firmware`.

## Was M1 tut

- Nach dem Start erscheint "Frei".
- Ein Tipp irgendwo auf das Display schaltet zum nächsten Screen. Der BOOT-Taster
  auf der Platine tut dasselbe.
- Reihenfolge: Frei, Bitte fragen, Nicht stören, Anfrage läuft, Herein!, Jetzt nicht.
- Auf "Anfrage läuft" zählt der Countdown 30 Sekunden herunter und schaltet am
  Ende von selbst weiter.

## Wenn etwas nicht klappt

- **Upload findet das Board nicht:** BOOT-Taster gedrückt halten, USB-Kabel
  einstecken, Taster loslassen, Upload wiederholen. Danach das Board einmal neu
  einstecken.
- **Bild steht auf dem Kopf:** In `firmware/include/config.h` den Wert
  `DISPLAY_ROTATION` von 1 auf 3 ändern und neu aufspielen.
- **Display bleibt schwarz:** Den seriellen Monitor in PlatformIO öffnen. Steht dort
  "Display nicht erkannt", hat die Firmware das Board nicht als 1,91-Zoll-Touch-Modell
  erkannt.
- **Zu hell oder zu dunkel:** `DISPLAY_BRIGHTNESS` in derselben Datei, 0 bis 255.

## Aufbau des Repositories

```
firmware/
  platformio.ini        Build-Konfiguration
  boards/               Board-Definition des Herstellers
  include/config.h      Einstellungen: Ausrichtung, Helligkeit, Frist
  include/lv_conf.h     LVGL-Konfiguration
  src/main.cpp          Start und Ablauf
  src/ui.cpp, ui.h      Die sechs Screens
  src/fonts/            Erzeugte Schriften und Icons
  lib/LilyGo_AMOLED/    Display- und Touch-Treiber des Herstellers
  tools/make_fonts.sh   Erzeugt die Schriften neu
hub/
  src/index.ts          Worker: Adressen, Schlüsselprüfung, Testseite
  src/door.ts           Durable Object: Zustand, Fristen, Verteilung
  src/protocol.ts       Nachrichten und ihre Prüfung
  test/smoke.mjs        Ablauftest gegen einen lokalen Hub
  README.md             Einrichtung bei Cloudflare
.github/workflows/      Tests und Ausrollen des Hubs
docs/protokoll.md       Nachrichten zwischen Display, Hub und App
docs/                   Bilder
```

Die iPhone-App kommt mit M4 als eigener Ordner dazu.

## Verwendete Software

| Teil | Lizenz |
| --- | --- |
| [LVGL](https://github.com/lvgl/lvgl) 9.6.0 | MIT |
| [LilyGo-AMOLED-Series](https://github.com/Xinyuan-LilyGO/LilyGo-AMOLED-Series), Kopie in `firmware/lib` | MIT |
| [SensorLib](https://github.com/lewisxhe/SensorLib) 0.5.1 | MIT |
| Schrift [Space Grotesk](https://github.com/floriankarsten/space-grotesk) | SIL Open Font License 1.1 |
| Schrift [Inter](https://github.com/rsms/inter) | SIL Open Font License 1.1 |
| [Tabler Icons](https://github.com/tabler/tabler-icons) | MIT |
| [Wrangler](https://github.com/cloudflare/workers-sdk) 4.162.0, nur zum Bauen | MIT oder Apache 2.0 |
