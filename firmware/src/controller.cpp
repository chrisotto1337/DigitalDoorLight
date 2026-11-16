#include "controller.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <lvgl.h>

#include "config.h"
#include "credentials.h"
#include "hub_client.h"
#include "ota.h"
#include "panel.h"
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

credentials::Values access;

// Nachtruhe: der Hub sagt, ob gerade Nacht ist. Nachts bleibt das Display
// dunkel, ein Tipp weckt es fuer WAKE_MS.
bool nightActive = false;
uint32_t awakeUntilMs = 0;

// Pixelversatz gegen Einbrennen, im Kreis um die Mitte
constexpr int8_t SHIFT_STEPS[][2] = {{0, 0},  {1, 0},  {1, 1},   {0, 1}, {-1, 1},
                                     {-1, 0}, {-1, -1}, {0, -1}, {1, -1}};
constexpr uint8_t SHIFT_STEP_COUNT = sizeof(SHIFT_STEPS) / sizeof(SHIFT_STEPS[0]);
uint8_t shiftStep = 0;
uint32_t lastShiftMs = 0;

bool updating = false;

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

// ---------- Display an und aus ----------

void keepAwake() {
    awakeUntilMs = millis() + config::WAKE_MS;
}

// Nachts dunkel, ausser jemand hat gerade getippt oder eine Anfrage laeuft.
void updatePanel() {
    if (overlay != Overlay::None) {
        keepAwake();
    }
    const bool dark =
        nightActive && static_cast<int32_t>(awakeUntilMs - millis()) <= 0;
    if (panel::isOn() == dark) {
        panel::setOn(!dark);
    }
}

void updateShift() {
    const uint32_t now = millis();
    if (!panel::isOn() || now - lastShiftMs < config::PIXEL_SHIFT_INTERVAL_MS) {
        return;
    }
    lastShiftMs = now;
    shiftStep = (shiftStep + 1) % SHIFT_STEP_COUNT;
    ui::setShift(SHIFT_STEPS[shiftStep][0] * config::PIXEL_SHIFT_PX,
                 SHIFT_STEPS[shiftStep][1] * config::PIXEL_SHIFT_PX);
}

// ---------- Update ueber WLAN ----------

void onUpdateProgress(uint32_t done, uint32_t total) {
    // Nur neu zeichnen, wenn sich die Prozentzahl aendert: das kostet Zeit.
    if (panel::isOn() && ui::setProgress(done, total)) {
        lv_refr_now(nullptr);
    }
}

void startUpdate() {
    updating = true;
    // Nachts laeuft das Update im Dunkeln.
    if (panel::isOn()) {
        ui::show(ui::Screen::Updating);
        ui::setProgress(0, 1);
        lv_refr_now(nullptr);
    }
    ota::run(access.deviceKey, onUpdateProgress);
    // Nur bei einem Fehler geht es hier weiter, sonst startet das Board neu.
    updating = false;
    showStatus();
}

void sendDeviceInfo() {
    JsonDocument message;
    message["typ"] = "geraet";
    // Bis M8 haengt das Display immer am USB-Netzteil.
    message["strom"] = "usb";
    message["akku_prozent"] = nullptr;
    message["firmware"] = ota::version();
    hub::send(message);
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
    } else if (strcmp(type, "nacht") == 0) {
        nightActive = message["aktiv"] | false;
        updatePanel();
    } else if (strcmp(type, "firmware") == 0) {
        ota::offer(message["version"] | "", message["md5"] | "");
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
    if (connected) {
        // Erreicht eine frisch installierte Firmware den Hub, ist sie gut.
        ota::confirm();
        sendDeviceInfo();
    }
    if (!connected && overlay == Overlay::Requesting) {
        // Ohne Hub kann keine Antwort kommen. Nach dem Neuverbinden meldet der
        // Hub eine noch laufende Anfrage von selbst.
        clearRequest();
        showStatus();
    }
}

// ---------- Touch ----------

void onTap(ui::Tap where) {
    if (updating) {
        return;
    }
    if (!panel::isOn()) {
        // Nachts weckt der erste Tipp nur. Erst der zweite fragt an.
        keepAwake();
        updatePanel();
        return;
    }
    keepAwake();

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
        case ui::Screen::Updating:
            break;
    }
}

// ---------- Zeitabhaengiges ----------

void updateConnectingDetail() {
    if (hasStatus) {
        return;
    }
    const char *detail = !credentials::complete(access) ? "WLAN-Daten fehlen"
                         : hub::wifiConnected()          ? "mit dem Hub"
                                                         : "mit dem WLAN";
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
    access = credentials::load();
    hub::begin(access, onMessage, onConnection);
}

void loop() {
    hub::loop();
    updateConnectingDetail();
    updateOverlay();
    updatePanel();
    updateShift();
    if (overlay == Overlay::None && hub::connected() && ota::due()) {
        startUpdate();
    }
}

void tap() {
    onTap(ui::Tap::Screen);
}

}  // namespace controller
