#pragma once

#include <stdint.h>

// Anzeige der Tuerampel: ein Bildschirm, sechs Zustaende.
namespace ui {

enum class Screen : uint8_t {
    Free,        // Gruen: Frei
    Ask,         // Gelb: Bitte fragen
    Busy,        // Rot: Nicht stoeren
    Requesting,  // Anfrage laeuft, mit Countdown
    Granted,     // Antwort Ja: Herein!
    Denied,      // Antwort Nein: Jetzt nicht
};

constexpr uint8_t SCREEN_COUNT = 6;

using TapHandler = void (*)();

// Baut die Oberflaeche auf. onTap wird bei jedem Tipp auf das Display gerufen.
void init(TapHandler onTap);

void show(Screen screen);
Screen current();

// Countdown auf dem Screen "Anfrage laeuft".
void setCountdown(uint32_t remainingMs, uint32_t totalMs);

// WLAN-Symbol oben rechts.
void setOnline(bool online);

}  // namespace ui
