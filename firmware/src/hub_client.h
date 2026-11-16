#pragma once

#include <ArduinoJson.h>

#include "credentials.h"

// Verbindung zum Hub: WLAN und WebSocket mit TLS.
// Nachrichten sind in docs/protokoll.md beschrieben.
namespace hub {

using MessageHandler = void (*)(JsonDocument &message);
using ConnectionHandler = void (*)(bool connected);

// Startet WLAN und Verbindungsaufbau. Die Handler laufen im Kontext von loop().
// Ohne vollstaendige Zugangsdaten bleibt das WLAN aus.
void begin(const credentials::Values &access, MessageHandler onMessage,
           ConnectionHandler onConnection);

// Muss staendig aus dem Arduino-loop() aufgerufen werden.
void loop();

bool wifiConnected();
bool connected();

// Schickt eine Nachricht an den Hub. false, wenn keine Verbindung besteht.
bool send(const JsonDocument &message);

}  // namespace hub
