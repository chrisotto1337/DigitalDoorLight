#pragma once

#include <Arduino.h>

// WLAN und Display-Schluessel.
//
// Sie liegen im Flash des Boards (NVS) und nicht in der Firmware, damit ein
// Update ueber WLAN keine Geheimnisse enthalten muss. Ein eigener Build bringt
// sie aus secrets.h mit und schreibt sie beim Start in den Flash.
namespace credentials {

struct Values {
    String wifiSsid;
    String wifiPassword;
    String deviceKey;
};

Values load();

// WLAN-Name und Schluessel vorhanden. Das Passwort darf leer sein.
bool complete(const Values &values);

}  // namespace credentials
