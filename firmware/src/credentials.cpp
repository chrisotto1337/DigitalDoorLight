#include "credentials.h"

#include <Preferences.h>

#if defined(TUERAMPEL_OHNE_SECRETS)
// Build von GitHub fuer das Update: ohne Geheimnisse, das Board nimmt die gespeicherten.
#define WIFI_SSID ""
#define WIFI_PASSWORD ""
#define HUB_DEVICE_KEY ""
#elif __has_include("secrets.h")
#include "secrets.h"
#else
#error "firmware/include/secrets.h fehlt: secrets.example.h kopieren und ausfuellen"
#endif

namespace credentials {

namespace {

constexpr const char *STORE = "zugang";

// Schreibt nur, wenn sich etwas aendert: der Flash vertraegt begrenzt viele Schreibvorgaenge.
void keep(Preferences &prefs, const char *key, const char *value, bool allowEmpty) {
    if (value[0] == '\0' && !allowEmpty) {
        return;
    }
    if (prefs.getString(key, "") != value) {
        prefs.putString(key, value);
        Serial.printf("[zugang] %s gespeichert\n", key);
    }
}

}  // namespace

Values load() {
    Preferences prefs;
    prefs.begin(STORE, false);
    // Ein Build mit secrets.h bringt immer einen WLAN-Namen mit. Dann gilt auch
    // ein leeres Passwort, etwa fuer ein offenes WLAN.
    const bool fromSecrets = WIFI_SSID[0] != '\0';
    keep(prefs, "ssid", WIFI_SSID, false);
    keep(prefs, "passwort", WIFI_PASSWORD, fromSecrets);
    keep(prefs, "schluessel", HUB_DEVICE_KEY, false);

    Values values{prefs.getString("ssid", ""), prefs.getString("passwort", ""),
                  prefs.getString("schluessel", "")};
    prefs.end();
    return values;
}

bool complete(const Values &values) {
    return values.wifiSsid.length() > 0 && values.deviceKey.length() > 0;
}

}  // namespace credentials
