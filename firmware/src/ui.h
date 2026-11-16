#pragma once

#include <stdint.h>

// Anzeige der Tuerampel: ein Bildschirm, mehrere Zustaende.
namespace ui {

enum class Screen : uint8_t {
    Connecting,  // Verbinde mit WLAN und Hub
    Free,        // Gruen: Frei
    Ask,         // Gelb: Bitte fragen
    Busy,        // Rot: Nicht stoeren
    Requesting,  // Anfrage laeuft, mit Countdown
    Granted,     // Antwort Ja: Herein!
    Denied,      // Antwort Nein: Jetzt nicht
    NoAnswer,    // Frist abgelaufen: Keine Antwort
};

// Wo getippt wurde: irgendwo auf dem Display oder auf das Feld unten.
enum class Tap : uint8_t {
    Screen,
    Footer,
};

using TapHandler = void (*)(Tap where);

// Baut die Oberflaeche auf und zeigt "Verbinde".
void init(TapHandler onTap);

void show(Screen screen);
Screen current();

// Countdown auf dem Screen "Anfrage laeuft".
void setCountdown(uint32_t remainingMs, uint32_t totalMs);

// WLAN-Symbol oben rechts.
void setOnline(bool online);

// Unterzeile auf dem Screen "Verbinde", zum Beispiel "mit dem WLAN".
void setConnectingDetail(const char *text);

}  // namespace ui
