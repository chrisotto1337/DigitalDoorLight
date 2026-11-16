// Tuerampel, Meilenstein 7: Dauerbetrieb an der Tuer.
//
// Das Display zeigt den Status, den die App setzt. Ein Tipp bei Gelb oder Rot
// schickt eine Anfrage, die Antwort erscheint auf dem Display. Nachts bleibt es
// dunkel, bis jemand tippt. Neue Firmware kommt ueber WLAN vom Hub.

#include <Arduino.h>
#include <LV_Helper.h>

#include "config.h"
#include "controller.h"
#include "ota.h"
#include "panel.h"

static bool buttonWasDown = false;
static uint32_t buttonChangedMs = 0;

static void pollButton() {
    const bool down = digitalRead(config::BUTTON_PIN) == LOW;
    const uint32_t now = millis();
    if (down != buttonWasDown && now - buttonChangedMs > 50) {
        buttonWasDown = down;
        buttonChangedMs = now;
        if (down) {
            controller::tap();
        }
    }
}

void setup() {
    Serial.begin(115200);
    // Ohne angeschlossenen Rechner darf die serielle Ausgabe nicht blockieren.
    Serial.setTxTimeoutMs(0);

    pinMode(config::BUTTON_PIN, INPUT_PULLUP);
    ota::begin();

    if (!panel::begin()) {
        while (true) {
            Serial.println("Display nicht erkannt. Ist es das T-Display S3 AMOLED 1,91 Zoll?");
            delay(2000);
        }
    }

    beginLvglHelper(panel::device());
    controller::begin();

    Serial.printf("Tuerampel %s gestartet, %u x %u\n", ota::version(), panel::device().width(),
                  panel::device().height());
}

void loop() {
    pollButton();
    controller::loop();
    ota::loop();
    lv_timer_handler();
    delay(5);
}
