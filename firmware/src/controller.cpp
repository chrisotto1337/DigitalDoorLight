#include "controller.h"

#include <Arduino.h>
#include <ArduinoJson.h>

#include "config.h"
#include "hub_client.h"
#include "ui.h"

namespace controller {

namespace {

// Was gerade ueber der Ampel liegt.
enum class Overlay : uint8_t {
    None,        // die Ampel selbst
    Requesting,  // Anfrage laeuft
    Result,      // Herein!, Jetzt nicht oder Keine Antwort
};

// Letzter Stand vom Hub
bool hasStatus = false;
ui::Screen statusScreen = ui::Screen::Free;

Overlay overlay = Overlay::None;
uint32_t resultUntilMs = 0;

// Laufende Anfrage
String requestId;              // leer, solange der Hub sie nicht bestaetigt hat
uint32_t requestSentMs = 0;
uint32_t requestEndMs = 0;
bool cancelWhenConfirmed = false;

const char *shownDetail = nullptr;

ui::Screen screenForColor(const char *color) {
    if (strcmp(color, "gelb") == 0) {
        return ui::Screen::Ask;
    }
    if (strcmp(color, "rot") == 0) {
        return ui::Screen::Busy;
    }
    return ui::Screen::Free;
}

void showStatus() {
    overlay = Overlay::None;
    ui::show(hasStatus ? statusScreen : ui::Screen::Connecting);
}

void clearRequest() {
    requestId = "";
    cancelWhenConfirmed = false;
}

void showResult(ui::Screen screen) {
    clearRequest();
    overlay = Overlay::Result;
    resultUntilMs = millis() + config::ANSWER_SHOW_MS;
    ui::show(screen);
}

void sendSimple(const char *type, const char *id = nullptr) {
    JsonDocument message;
    message["typ"] = type;
    if (id != nullptr) {
        message["id"] = id;
    }
    hub::send(message);
}

void startRequest() {
    if (!hub::connected()) {
        Serial.println("[ampel] offline, Anfrage nicht moeglich");
        return;
    }
    sendSimple("anfrage");
    // Sofort anzeigen, der Hub bestaetigt in der Regel nach wenigen hundert Millisekunden.
    clearRequest();
    overlay = Overlay::Requesting;
    requestSentMs = millis();
    requestEndMs = requestSentMs + config::REQUEST_TIMEOUT_MS;
    ui::show(ui::Screen::Requesting);
    ui::setCountdown(config::REQUEST_TIMEOUT_MS, config::REQUEST_TIMEOUT_MS);
}

void cancelRequest() {
    if (requestId.length() > 0) {
        sendSimple("abbruch", requestId.c_str());
        clearRequest();
    } else {
        // Noch keine id vom Hub: abbrechen, sobald sie kommt.
        cancelWhenConfirmed = true;
    }
    showStatus();
}

// ---------- Nachrichten vom Hub ----------

void onMessage(JsonDocument &message) {
    const char *type = message["typ"] | "";
    const char *id = message["id"] | "";

    if (strcmp(type, "status") == 0) {
        statusScreen = screenForColor(message["farbe"] | "gruen");
        hasStatus = true;
        if (overlay == Overlay::None) {
            showStatus();
        }
    } else if (strcmp(type, "anfrage") == 0) {
        if (cancelWhenConfirmed) {
            sendSimple("abbruch", id);
            clearRequest();
            return;
        }
        requestId = id;
        const uint32_t rest = message["rest_ms"] | config::REQUEST_TIMEOUT_MS;
        requestEndMs = millis() + rest;
        overlay = Overlay::Requesting;
        ui::show(ui::Screen::Requesting);
        ui::setCountdown(rest, config::REQUEST_TIMEOUT_MS);
    } else if (strcmp(type, "antwort") == 0) {
        if (overlay == Overlay::Requesting) {
            showResult((message["ja"] | false) ? ui::Screen::Granted : ui::Screen::Denied);
        }
    } else if (strcmp(type, "frist_abgelaufen") == 0) {
        if (overlay == Overlay::Requesting) {
            showResult(ui::Screen::NoAnswer);
        }
    } else if (strcmp(type, "abbruch") == 0) {
        if (overlay == Overlay::Requesting) {
            clearRequest();
            showStatus();
        }
    } else if (strcmp(type, "fehler") == 0) {
        Serial.printf("[ampel] Hub meldet: %s\n", message["grund"] | "");
        // Eine abgelehnte Anfrage, etwa weil die Ampel inzwischen auf Gruen steht
        if (overlay == Overlay::Requesting && requestId.length() == 0) {
            clearRequest();
            showStatus();
        }
    }
}

void onConnection(bool connected) {
    ui::setOnline(connected);
    if (!connected && overlay == Overlay::Requesting) {
        // Ohne Hub kann keine Antwort kommen. Nach dem Neuverbinden meldet der
        // Hub eine noch laufende Anfrage von selbst.
        clearRequest();
        showStatus();
    }
}

// ---------- Touch ----------

void onTap(ui::Tap where) {
    switch (ui::current()) {
        case ui::Screen::Ask:
        case ui::Screen::Busy:
            startRequest();
            break;
        case ui::Screen::Requesting:
            if (where == ui::Tap::Footer) {
                cancelRequest();
            }
            break;
        case ui::Screen::Granted:
        case ui::Screen::Denied:
        case ui::Screen::NoAnswer:
            showStatus();
            break;
        case ui::Screen::Free:
        case ui::Screen::Connecting:
            break;
    }
}

// ---------- Zeitabhaengiges ----------

void updateConnectingDetail() {
    if (hasStatus) {
        return;
    }
    const char *detail = hub::wifiConnected() ? "mit dem Hub" : "mit dem WLAN";
    if (detail != shownDetail) {
        shownDetail = detail;
        ui::setConnectingDetail(detail);
    }
}

void updateOverlay() {
    const uint32_t now = millis();

    if (overlay == Overlay::Requesting) {
        if (requestId.length() == 0 && now - requestSentMs > config::REQUEST_ACK_TIMEOUT_MS) {
            Serial.println("[ampel] Hub hat die Anfrage nicht bestaetigt");
            clearRequest();
            showStatus();
            return;
        }
        const int32_t rest = static_cast<int32_t>(requestEndMs - now);
        ui::setCountdown(rest > 0 ? rest : 0, config::REQUEST_TIMEOUT_MS);
        // Sicherheitsnetz, falls die Meldung vom Hub ausbleibt
        if (rest < -3000) {
            showResult(ui::Screen::NoAnswer);
        }
    } else if (overlay == Overlay::Result) {
        if (static_cast<int32_t>(resultUntilMs - now) <= 0) {
            showStatus();
        }
    }
}

}  // namespace

void begin() {
    ui::init(onTap);
    hub::begin(onMessage, onConnection);
}

void loop() {
    hub::loop();
    updateConnectingDetail();
    updateOverlay();
}

void tap() {
    onTap(ui::Tap::Screen);
}

}  // namespace controller
