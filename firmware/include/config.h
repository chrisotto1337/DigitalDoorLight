#pragma once

#include <stdint.h>

// Einstellungen, die man beim Aufbau an der Tuer anpassen will.
namespace config {

// Hochformat: 1 oder 3. Steht das Bild auf dem Kopf, den anderen Wert nehmen.
constexpr uint8_t DISPLAY_ROTATION = 1;

// Helligkeit von 0 bis 255.
constexpr uint8_t DISPLAY_BRIGHTNESS = 200;

// Wie lange eine Anfrage auf Antwort wartet.
constexpr uint32_t REQUEST_TIMEOUT_MS = 30000;

// Taster auf der Platine (BOOT). Schaltet in M1 wie ein Tipp weiter.
constexpr uint8_t BUTTON_PIN = 0;

}  // namespace config
