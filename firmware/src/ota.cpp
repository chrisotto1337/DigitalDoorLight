#include "ota.h"

#include <HTTPUpdate.h>
#include <NetworkClientSecure.h>
#include <Preferences.h>
#include <esp_ota_ops.h>

#include "config.h"

// Setzt tools/version.py beim Bauen
#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "unbekannt"
#endif

// Wurzelzertifikate aus dem ESP-IDF, wie beim WebSocket zum Hub
extern const uint8_t ROOT_CERTS_START[] asm("_binary_x509_crt_bundle_start");
extern const uint8_t ROOT_CERTS_END[] asm("_binary_x509_crt_bundle_end");

// Das Arduino-Framework wuerde eine neue Firmware sofort als gut markieren.
// So entscheidet ota::confirm() oder der Ruecksprung in ota::loop().
extern "C" bool verifyRollbackLater() {
    return true;
}

namespace ota {

namespace {

constexpr const char *STORE = "ota";
constexpr const char *FIRMWARE_PATH = "/firmware/tuerampel.bin";

bool pendingVerify = false;
uint32_t verifyDeadlineMs = 0;

String offered;
String offeredMd5;
bool waitForRetry = false;
uint32_t retryAtMs = 0;

bool isLocalBuild() {
    return strstr(FIRMWARE_VERSION, "+lokal") != nullptr;
}

// Diese Version ist schon zu oft gescheitert.
bool isBlocked(const char *candidate) {
    Preferences prefs;
    prefs.begin(STORE, true);
    const bool blocked = prefs.getString("fehl_ver", "") == candidate &&
                         prefs.getUChar("fehl_zahl", 0) >= config::OTA_MAX_FAILURES;
    prefs.end();
    return blocked;
}

}  // namespace

const char *version() {
    return FIRMWARE_VERSION;
}

void begin() {
    const esp_partition_t *running = esp_ota_get_running_partition();
    Serial.printf("[ota] Firmware %s auf %s\n", FIRMWARE_VERSION, running->label);
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) == ESP_OK &&
        state == ESP_OTA_IMG_PENDING_VERIFY) {
        pendingVerify = true;
        verifyDeadlineMs = millis() + config::OTA_VERIFY_TIMEOUT_MS;
        Serial.println("[ota] neue Firmware, wartet auf den Hub");
    }

    // Lief zuletzt ein Update, das jetzt nicht laeuft, ist es gescheitert.
    Preferences prefs;
    prefs.begin(STORE, false);
    const String attempt = prefs.getString("versuch", "");
    if (attempt.length() > 0 && attempt != FIRMWARE_VERSION) {
        const uint8_t failures =
            prefs.getString("fehl_ver", "") == attempt ? prefs.getUChar("fehl_zahl", 0) : 0;
        prefs.putString("fehl_ver", attempt);
        prefs.putUChar("fehl_zahl", failures + 1);
        prefs.remove("versuch");
        Serial.printf("[ota] Update auf %s gescheitert, Fehlschlag %u\n", attempt.c_str(),
                      failures + 1);
    } else if (attempt.length() > 0 && !pendingVerify) {
        prefs.remove("versuch");
    }
    prefs.end();
}

void confirm() {
    if (!pendingVerify) {
        return;
    }
    pendingVerify = false;
    esp_ota_mark_app_valid_cancel_rollback();
    Preferences prefs;
    prefs.begin(STORE, false);
    prefs.remove("versuch");
    prefs.end();
    Serial.println("[ota] neue Firmware bestaetigt");
}

void loop() {
    if (pendingVerify && static_cast<int32_t>(millis() - verifyDeadlineMs) >= 0) {
        Serial.println("[ota] Hub nicht erreicht, zurueck zur alten Firmware");
        // Startet neu und kehrt nur zurueck, wenn es keine alte Firmware gibt.
        esp_ota_mark_app_invalid_rollback_and_reboot();
        pendingVerify = false;
    }
}

void offer(const char *candidate, const char *md5) {
    if (candidate[0] == '\0' || strcmp(candidate, FIRMWARE_VERSION) == 0 || isLocalBuild() ||
        strlen(md5) != 32) {
        offered = "";
        return;
    }
    if (isBlocked(candidate)) {
        if (offered.length() > 0) {
            Serial.printf("[ota] %s ist zu oft gescheitert, bleibe bei %s\n", candidate,
                          FIRMWARE_VERSION);
        }
        offered = "";
        return;
    }
    if (offered != candidate) {
        offered = candidate;
        offeredMd5 = md5;
        waitForRetry = false;
        Serial.printf("[ota] Update von %s auf %s angeboten\n", FIRMWARE_VERSION, candidate);
    }
}

bool due() {
    return offered.length() > 0 && !pendingVerify &&
           (!waitForRetry || static_cast<int32_t>(millis() - retryAtMs) >= 0);
}

void run(const String &deviceKey, ProgressHandler onProgress) {
    NetworkClientSecure client;
    client.setCACertBundle(ROOT_CERTS_START, ROOT_CERTS_END - ROOT_CERTS_START);

    HTTPUpdate updater(20000);
    updater.rebootOnUpdate(false);
    // Die Pruefsumme kommt ueber die Verbindung zum Hub, nicht mit der Datei.
    updater.setMD5sum(offeredMd5);
    if (onProgress != nullptr) {
        updater.onProgress([onProgress](int done, int total) {
            onProgress(static_cast<uint32_t>(done), static_cast<uint32_t>(total));
        });
    }

    // Der Schluessel besteht nur aus 0-9 und a-f und braucht keine URL-Kodierung.
    const String url =
        String("https://") + config::HUB_HOST + FIRMWARE_PATH + "?key=" + deviceKey;
    Serial.printf("[ota] lade %s\n", offered.c_str());
    const t_httpUpdate_return result = updater.update(client, url, FIRMWARE_VERSION);

    if (result == HTTP_UPDATE_OK) {
        Preferences prefs;
        prefs.begin(STORE, false);
        prefs.putString("versuch", offered);
        prefs.end();
        Serial.println("[ota] installiert, starte neu");
        delay(200);
        ESP.restart();
    }

    Serial.printf("[ota] fehlgeschlagen: %s\n", updater.getLastErrorString().c_str());
    waitForRetry = true;
    retryAtMs = millis() + config::OTA_RETRY_MS;
}

}  // namespace ota
