#pragma once

#include <Arduino.h>

// Update ueber WLAN.
//
// Der Hub bietet eine Firmware an, das Display laedt sie von dort und startet
// neu. Die neue Firmware gilt erst als gut, wenn sie den Hub erreicht. Sonst
// kehrt das Board nach OTA_VERIFY_TIMEOUT_MS zur alten Firmware zurueck.
namespace ota {

// Kennung dieser Firmware, etwa "a1b2c3d4e5" oder "a1b2c3d4e5+lokal".
// Eigene Builds mit Aenderungen ("+lokal") ersetzt das Board nie von selbst.
const char *version();

// Beim Start, vor allem anderen.
void begin();

// Der Hub ist erreichbar: eine frisch installierte Firmware gilt damit als gut.
void confirm();

// Ruecksprung, falls die neue Firmware den Hub nicht erreicht.
void loop();

// Angebot vom Hub merken.
void offer(const char *version, const char *md5);

// Ein Update steht an und darf jetzt laufen.
bool due();

using ProgressHandler = void (*)(uint32_t done, uint32_t total);

// Laedt die angebotene Firmware und startet neu. Kehrt nur zurueck, wenn
// etwas schiefging, dann folgt der naechste Versuch nach OTA_RETRY_MS.
void run(const String &deviceKey, ProgressHandler onProgress);

}  // namespace ota
