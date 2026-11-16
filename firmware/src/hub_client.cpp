#include "hub_client.h"

#include <Arduino.h>
#include <WebSocketsClient.h>
#include <WiFi.h>

#include "config.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "firmware/include/secrets.h fehlt: secrets.example.h kopieren und ausfuellen"
#endif

// Wurzelzertifikate aus dem ESP-IDF (Mozilla-Liste), damit das Display prueft,
// dass es wirklich mit Cloudflare spricht.
extern const uint8_t ROOT_CERTS_START[] asm("_binary_x509_crt_bundle_start");
extern const uint8_t ROOT_CERTS_END[] asm("_binary_x509_crt_bundle_end");

namespace hub {

namespace {

WebSocketsClient socket;
MessageHandler messageHandler = nullptr;
ConnectionHandler connectionHandler = nullptr;

String path;
bool socketStarted = false;
bool isConnected = false;
uint32_t lastReceivedMs = 0;
uint32_t lastPingMs = 0;

void setConnected(bool value) {
    if (value == isConnected) {
        return;
    }
    isConnected = value;
    Serial.printf("[hub] %s\n", value ? "verbunden" : "getrennt");
    if (connectionHandler != nullptr) {
        connectionHandler(value);
    }
}

void handleText(const uint8_t *payload, size_t length) {
    lastReceivedMs = millis();
    if (length == 4 && memcmp(payload, "pong", 4) == 0) {
        return;
    }

    JsonDocument message;
    const DeserializationError error = deserializeJson(message, payload, length);
    if (error) {
        Serial.printf("[hub] ungueltige Nachricht: %s\n", error.c_str());
        return;
    }
    if (messageHandler != nullptr) {
        messageHandler(message);
    }
}

void onSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
    switch (type) {
        case WStype_CONNECTED:
            lastReceivedMs = millis();
            lastPingMs = millis();
            setConnected(true);
            break;
        case WStype_DISCONNECTED:
            setConnected(false);
            break;
        case WStype_TEXT:
            Serial.printf("[hub] <- %.*s\n", static_cast<int>(length),
                          reinterpret_cast<const char *>(payload));
            handleText(payload, length);
            break;
        case WStype_ERROR:
            Serial.printf("[hub] Fehler: %.*s\n", static_cast<int>(length),
                          reinterpret_cast<const char *>(payload));
            break;
        default:
            break;
    }
}

void startSocket() {
    socket.beginSslWithBundle(config::HUB_HOST, config::HUB_PORT, path.c_str(),
                              ROOT_CERTS_START, ROOT_CERTS_END - ROOT_CERTS_START, "");
    socket.onEvent(onSocketEvent);
    socket.setReconnectInterval(config::RECONNECT_INTERVAL_MS);
    socketStarted = true;
    Serial.printf("[hub] verbinde mit %s\n", config::HUB_HOST);
}

}  // namespace

void begin(MessageHandler onMessage, ConnectionHandler onConnection) {
    messageHandler = onMessage;
    connectionHandler = onConnection;

    // Der Schluessel besteht nur aus 0-9 und a-f und braucht keine URL-Kodierung.
    path = String("/ws/display?key=") + HUB_DEVICE_KEY;

    WiFi.mode(WIFI_STA);
    WiFi.setHostname("tuerampel");
    // Am USB-Netzteil kein Stromsparen: Statuswechsel kommen sofort an.
    WiFi.setSleep(false);
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.printf("[wlan] verbinde mit %s\n", WIFI_SSID);
}

void loop() {
    if (WiFi.status() != WL_CONNECTED) {
        if (socketStarted) {
            // Ohne WLAN die Verbindung sauber beenden, sie startet danach neu.
            socket.disconnect();
            socketStarted = false;
            Serial.println("[wlan] getrennt");
        }
        setConnected(false);
        return;
    }

    if (!socketStarted) {
        Serial.printf("[wlan] verbunden, IP %s, Signal %d dBm\n",
                      WiFi.localIP().toString().c_str(), WiFi.RSSI());
        startSocket();
    }

    socket.loop();

    if (!isConnected) {
        return;
    }
    const uint32_t now = millis();
    if (now - lastReceivedMs > config::LINK_TIMEOUT_MS) {
        Serial.println("[hub] keine Antwort mehr, baue Verbindung neu auf");
        socket.disconnect();
        setConnected(false);
        return;
    }
    if (now - lastPingMs >= config::PING_INTERVAL_MS) {
        lastPingMs = now;
        socket.sendTXT("ping");
    }
}

bool wifiConnected() {
    return WiFi.status() == WL_CONNECTED;
}

bool connected() {
    return isConnected;
}

bool send(const JsonDocument &message) {
    if (!isConnected) {
        return false;
    }
    String text;
    serializeJson(message, text);
    Serial.printf("[hub] -> %s\n", text.c_str());
    return socket.sendTXT(text);
}

}  // namespace hub
