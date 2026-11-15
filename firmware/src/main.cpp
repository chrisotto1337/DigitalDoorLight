// Tuerampel, Meilenstein 1: das Display zeigt alle sechs Zustaende.
//
// Noch ohne WLAN und Hub. Ein Tipp auf das Display oder ein Druck auf den
// BOOT-Taster schaltet zum naechsten Screen. Auf "Anfrage laeuft" zaehlt der
// Countdown herunter und schaltet am Ende von selbst weiter.

#include <Arduino.h>
#include <LV_Helper.h>
#include <LilyGo_AMOLED.h>

#include "config.h"
#include "ui.h"

static LilyGo_Class amoled;

static uint32_t requestStartedMs = 0;
static bool buttonWasDown = false;
static uint32_t buttonChangedMs = 0;

static void showScreen(ui::Screen screen) {
    ui::show(screen);
    if (screen == ui::Screen::Requesting) {
        requestStartedMs = millis();
        ui::setCountdown(config::REQUEST_TIMEOUT_MS, config::REQUEST_TIMEOUT_MS);
    }
    Serial.printf("Screen %u\n", static_cast<unsigned>(screen));
}

static void showNextScreen() {
    const uint8_t next =
        (static_cast<uint8_t>(ui::current()) + 1) % ui::SCREEN_COUNT;
    showScreen(static_cast<ui::Screen>(next));
}

static void pollButton() {
    const bool down = digitalRead(config::BUTTON_PIN) == LOW;
    const uint32_t now = millis();
    if (down != buttonWasDown && now - buttonChangedMs > 50) {
        buttonWasDown = down;
        buttonChangedMs = now;
        if (down) {
            showNextScreen();
        }
    }
}

static void updateCountdown() {
    if (ui::current() != ui::Screen::Requesting) {
        return;
    }
    const uint32_t elapsed = millis() - requestStartedMs;
    if (elapsed >= config::REQUEST_TIMEOUT_MS) {
        showNextScreen();
        return;
    }
    ui::setCountdown(config::REQUEST_TIMEOUT_MS - elapsed,
                     config::REQUEST_TIMEOUT_MS);
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
    ui::init(showNextScreen);

    Serial.printf("Tuerampel M1 gestartet, %u x %u\n", amoled.width(), amoled.height());
}

void loop() {
    pollButton();
    updateCountdown();
    lv_timer_handler();
    delay(5);
}
