#include "keepalive.h"

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>

#include "config.h"

namespace keepalive {

namespace {

// Port 9 ("discard"): der Router verwirft die Pakete, sie verlassen das Heimnetz nicht.
constexpr uint16_t DISCARD_PORT = 9;
constexpr size_t PACKET_SIZE = 1200;
constexpr uint32_t PACKET_GAP_MS = 4;

uint8_t packet[PACKET_SIZE];

void pulse() {
    WiFiUDP udp;
    volatile uint32_t work = 0;
    const uint32_t start = millis();
    uint32_t lastPacketMs = start - PACKET_GAP_MS;

    while (millis() - start < config::KEEPALIVE_PULSE_MS) {
        const uint32_t now = millis();
        if (now - lastPacketMs >= PACKET_GAP_MS && WiFi.status() == WL_CONNECTED) {
            lastPacketMs = now;
            if (udp.beginPacket(WiFi.gatewayIP(), DISCARD_PORT)) {
                udp.write(packet, PACKET_SIZE);
                udp.endPacket();
            }
        }
        // Rechenlast: der Kern schlaeft sonst zwischen zwei Aufgaben.
        for (uint32_t i = 0; i < 2000; i++) {
            work = work * 1664525UL + 1013904223UL;
        }
    }
}

void task(void *) {
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(config::KEEPALIVE_INTERVAL_MS - config::KEEPALIVE_PULSE_MS));
        pulse();
    }
}

}  // namespace

void begin() {
    if (!config::KEEPALIVE_ENABLED) {
        return;
    }
    static_assert(config::KEEPALIVE_PULSE_MS < config::KEEPALIVE_INTERVAL_MS,
                  "Der Puls muss kuerzer sein als der Takt");
    // Unter 5 Sekunden bleiben, sonst meldet sich der Watchdog des Kerns.
    static_assert(config::KEEPALIVE_PULSE_MS <= 3000, "Puls hoechstens 3 Sekunden");
    memset(packet, 0x55, PACKET_SIZE);
    // Kern 0, niedrigste Prioritaet: Anzeige und Touch laufen auf Kern 1 ungestoert,
    // das WLAN auf Kern 0 hat Vorrang.
    xTaskCreatePinnedToCore(task, "keepalive", 4096, nullptr, 1, nullptr, 0);
    Serial.printf("[strom] Powerbank-Puls: %lu ms alle %lu s\n",
                  static_cast<unsigned long>(config::KEEPALIVE_PULSE_MS),
                  static_cast<unsigned long>(config::KEEPALIVE_INTERVAL_MS / 1000));
}

}  // namespace keepalive
