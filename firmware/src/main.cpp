// Tuerampel, Meilenstein 3: das Display haengt am Hub.
//
// Es zeigt den Status, den die App setzt. Ein Tipp bei Gelb oder Rot schickt
// eine Anfrage, die Antwort erscheint auf dem Display. Ohne Verbindung zeigt
// das Symbol oben rechts ein durchgestrichenes WLAN.

#include <Arduino.h>
#include <LV_Helper.h>
#include <LilyGo_AMOLED.h>

#include "config.h"
#include "controller.h"

static LilyGo_Class amoled;

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

    if (!amoled.begin()) {
        while (true) {
            Serial.println("Display nicht erkannt. Ist es das T-Display S3 AMOLED 1,91 Zoll?");
            delay(2000);
        }
    }

    amoled.setRotation(config::DISPLAY_ROTATION);
    amoled.setBrightness(config::DISPLAY_BRIGHTNESS);

    beginLvglHelper(amoled);
    controller::begin();

    Serial.printf("Tuerampel M3 gestartet, %u x %u\n", amoled.width(), amoled.height());
}

void loop() {
    pollButton();
    controller::loop();
    lv_timer_handler();
    delay(5);
}
