#pragma once

#include <lvgl.h>

// Erzeugt mit firmware/tools/make_fonts.sh. Nicht von Hand aendern.

// Space Grotesk Bold: Ueberschriften
LV_FONT_DECLARE(font_title_64);
LV_FONT_DECLARE(font_title_46);
LV_FONT_DECLARE(font_title_40);

// Inter SemiBold: Fliesstext
LV_FONT_DECLARE(font_text_20);
LV_FONT_DECLARE(font_text_17);

// Tabler Icons. font_icon_104 enthaelt alle Icons unten,
// font_icon_22 nur ICON_WIFI und ICON_WIFI_OFF.
LV_FONT_DECLARE(font_icon_104);
LV_FONT_DECLARE(font_icon_22);

// UTF-8 als Byte-Folge, die Zeichen liegen im privaten Unicode-Bereich der Icon-Schrift.
#define ICON_CHECK    "\xEE\xA9\x9E"  // U+EA5E check
#define ICON_QUESTION "\xEE\xB2\x9D"  // U+EC9D question-mark
#define ICON_MINUS    "\xEE\xAB\xB2"  // U+EAF2 minus
#define ICON_X        "\xEE\xAD\x95"  // U+EB55 x
#define ICON_DOOR     "\xEE\xBD\x8C"  // U+EF4C door-enter
#define ICON_BELL     "\xEE\xA8\xB5"  // U+EA35 bell
#define ICON_CLOCK    "\xEE\xA9\xB0"  // U+EA70 clock
#define ICON_WIFI     "\xEE\xAD\x92"  // U+EB52 wifi
#define ICON_WIFI_OFF "\xEE\xB3\xBA"  // U+ECFA wifi-off
