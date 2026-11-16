#pragma once

#include <stdint.h>

// Einstellungen, die man beim Aufbau an der Tuer anpassen will.
// Geheime Werte (WLAN, Schluessel) stehen in secrets.h.
namespace config {

// ---------- Display ----------

// Hochformat: 1 oder 3. Steht das Bild auf dem Kopf, den anderen Wert nehmen.
constexpr uint8_t DISPLAY_ROTATION = 1;

// Helligkeit von 0 bis 255. Mehr laesst das AMOLED schneller altern.
constexpr uint8_t DISPLAY_BRIGHTNESS = 200;

// Taster auf der Platine (BOOT). Wirkt wie ein Tipp auf das Display.
constexpr uint8_t BUTTON_PIN = 0;

// ---------- Hub ----------

constexpr const char *HUB_HOST = "tuerampel-hub.chris-otto.workers.dev";
constexpr uint16_t HUB_PORT = 443;

// Lebenszeichen an den Hub. Bleibt die Antwort so lange aus, baut das Display
// die Verbindung neu auf.
constexpr uint32_t PING_INTERVAL_MS = 30000;
constexpr uint32_t LINK_TIMEOUT_MS = 75000;

// Wartezeit zwischen zwei Verbindungsversuchen.
constexpr uint32_t RECONNECT_INTERVAL_MS = 5000;

// ---------- Ablauf ----------

// Wie lange eine Anfrage auf Antwort wartet. Muss zu ANFRAGE_FRIST_S im Hub passen.
constexpr uint32_t REQUEST_TIMEOUT_MS = 30000;

// Bestaetigt der Hub eine Anfrage nicht in dieser Zeit, kehrt das Display zurueck.
constexpr uint32_t REQUEST_ACK_TIMEOUT_MS = 5000;

// Wie lange "Herein!", "Jetzt nicht" oder "Keine Antwort" stehen bleiben.
constexpr uint32_t ANSWER_SHOW_MS = 6000;

// ---------- Dauerbetrieb ----------

// Nachtruhe: So lange bleibt das Display nach einem Tipp hell. Die Zeiten
// stellt man in der App ein.
constexpr uint32_t WAKE_MS = 10000;

// Gegen Einbrennen wandert der Inhalt in diesem Takt um einige Pixel.
constexpr uint32_t PIXEL_SHIFT_INTERVAL_MS = 120000;
constexpr int32_t PIXEL_SHIFT_PX = 4;

// Update ueber WLAN: nach einem Fehlschlag erst nach dieser Zeit neu versuchen.
constexpr uint32_t OTA_RETRY_MS = 30UL * 60 * 1000;

// Erreicht eine neue Firmware den Hub nicht in dieser Zeit, kehrt das Board
// zur alten zurueck. Nach drei Fehlschlaegen laesst es diese Version aus.
constexpr uint32_t OTA_VERIFY_TIMEOUT_MS = 5UL * 60 * 1000;
constexpr uint8_t OTA_MAX_FAILURES = 3;

}  // namespace config
