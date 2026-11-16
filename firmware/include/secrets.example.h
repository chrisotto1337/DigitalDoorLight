#pragma once

// Vorlage: Diese Datei nach secrets.h kopieren und die Werte eintragen.
// secrets.h steht in .gitignore und kommt nie ins Repository.

// WLAN, mit dem sich das Display verbindet. Nur 2,4 GHz, der ESP32 kann kein 5 GHz.
#define WIFI_SSID "Name-deines-WLANs"
#define WIFI_PASSWORD "WLAN-Passwort"

// Display-Schluessel, derselbe Wert wie im GitHub-Secret HUB_DEVICE_KEY.
#define HUB_DEVICE_KEY "64-zeichen-schluessel"
