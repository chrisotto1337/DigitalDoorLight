#include "ui.h"

#include <lvgl.h>

#include "fonts/fonts.h"

namespace ui {

namespace {

// Farben aus dem Entwurf
constexpr uint32_t COLOR_BACKGROUND = 0x000000;
constexpr uint32_t COLOR_TEXT       = 0xFFFFFF;
constexpr uint32_t COLOR_TEXT_MUTED = 0xC9D1D9;
constexpr uint32_t COLOR_STATUS     = 0x8B96A3;
constexpr uint32_t COLOR_TRACK      = 0x2A3138;
constexpr uint32_t COLOR_GREEN      = 0x19A654;
constexpr uint32_t COLOR_YELLOW     = 0xF5B800;
constexpr uint32_t COLOR_RED        = 0xE5372C;
constexpr uint32_t COLOR_ON_GREEN   = 0x04210F;
constexpr uint32_t COLOR_ON_YELLOW  = 0x1F1600;
constexpr uint32_t COLOR_ON_RED     = 0xFFFFFF;

// Masse aus dem Entwurf (240 x 536)
constexpr int32_t PADDING       = 16;
constexpr int32_t STATUS_HEIGHT = 22;
constexpr int32_t FOOTER_HEIGHT = 72;
constexpr int32_t BAR_RANGE     = 1000;

struct ScreenSpec {
    const char *icon;
    bool onDisc;            // Icon auf farbiger Scheibe oder frei stehend
    int32_t discSize;
    uint32_t accent;        // Farbe der Scheibe bzw. des frei stehenden Icons
    uint32_t onAccent;      // Farbe des Icons auf der Scheibe
    const char *title;
    const lv_font_t *titleFont;
    int32_t titleLineSpace;
    const char *subtitle;
    const char *footer;     // nullptr: kein Feld unten
    uint32_t footerBorder;
    bool countdown;
};

const ScreenSpec SPECS[SCREEN_COUNT] = {
    // Free
    {ICON_CHECK, true, 184, COLOR_GREEN, COLOR_ON_GREEN,
     "Frei", &font_title_64, 0, "Komm rein", nullptr, 0, false},
    // Ask
    {ICON_QUESTION, true, 176, COLOR_YELLOW, COLOR_ON_YELLOW,
     "Bitte\nfragen", &font_title_46, -12, "Bin beschäftigt",
     "Zum Anfragen tippen", COLOR_YELLOW, false},
    // Busy
    {ICON_MINUS, true, 176, COLOR_RED, COLOR_ON_RED,
     "Nicht\nstören", &font_title_46, -12, "Im Termin",
     "Zum Anfragen tippen", COLOR_RED, false},
    // Requesting
    {ICON_BELL, false, 0, COLOR_YELLOW, 0,
     "Anfrage\nläuft", &font_title_40, -10, "Warte auf Antwort",
     "Abbrechen", COLOR_STATUS, true},
    // Granted
    {ICON_DOOR, true, 184, COLOR_GREEN, COLOR_ON_GREEN,
     "Herein!", &font_title_46, 0, "Du darfst rein", nullptr, 0, false},
    // Denied
    {ICON_X, true, 176, COLOR_RED, COLOR_ON_RED,
     "Jetzt\nnicht", &font_title_46, -12, "Später nochmal", nullptr, 0, false},
};

lv_obj_t *statusIcon     = nullptr;
lv_obj_t *disc           = nullptr;
lv_obj_t *discIcon       = nullptr;
lv_obj_t *plainIcon      = nullptr;
lv_obj_t *title          = nullptr;
lv_obj_t *subtitle       = nullptr;
lv_obj_t *bar            = nullptr;
lv_obj_t *countdownLabel = nullptr;
lv_obj_t *footer         = nullptr;
lv_obj_t *footerLabel    = nullptr;

Screen currentScreen   = Screen::Free;
TapHandler tapHandler  = nullptr;
uint32_t shownSeconds  = UINT32_MAX;

// Ein reiner Layout-Behaelter: unsichtbar, nicht scrollbar, laesst Tipps durch.
lv_obj_t *makeBox(lv_obj_t *parent) {
    lv_obj_t *box = lv_obj_create(parent);
    lv_obj_remove_style_all(box);
    lv_obj_set_clickable(box, false);
    lv_obj_set_scrollable(box, false);
    return box;
}

lv_obj_t *makeLabel(lv_obj_t *parent, const lv_font_t *font, uint32_t color) {
    lv_obj_t *label = lv_label_create(parent);
    lv_obj_set_style_text_font(label, font, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(color), 0);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
    return label;
}

void onScreenClicked(lv_event_t *) {
    if (tapHandler != nullptr) {
        tapHandler();
    }
}

}  // namespace

void init(TapHandler onTap) {
    tapHandler = onTap;

    lv_obj_t *root = lv_screen_active();
    lv_obj_set_style_bg_color(root, lv_color_hex(COLOR_BACKGROUND), 0);
    lv_obj_set_style_bg_opa(root, LV_OPA_COVER, 0);
    lv_obj_set_scrollable(root, false);
    // Das ganze Display ist die Tippflaeche.
    lv_obj_set_clickable(root, true);
    lv_obj_add_event_cb(root, onScreenClicked, LV_EVENT_CLICKED, nullptr);

    const int32_t width  = lv_display_get_horizontal_resolution(nullptr);
    const int32_t height = lv_display_get_vertical_resolution(nullptr);
    const int32_t contentWidth = width - 2 * PADDING;

    // Statuszeile oben rechts
    statusIcon = makeLabel(root, &font_icon_22, COLOR_STATUS);
    lv_label_set_text(statusIcon, ICON_WIFI);
    lv_obj_align(statusIcon, LV_ALIGN_TOP_RIGHT, -PADDING, PADDING);

    // Mittlerer Bereich: Icon, Ueberschrift, Unterzeile, Countdown
    lv_obj_t *column = makeBox(root);
    lv_obj_set_size(column, contentWidth,
                    height - 2 * PADDING - STATUS_HEIGHT - FOOTER_HEIGHT);
    lv_obj_align(column, LV_ALIGN_TOP_MID, 0, PADDING + STATUS_HEIGHT);
    lv_obj_set_flex_flow(column, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(column, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(column, 16, 0);

    disc = makeBox(column);
    lv_obj_set_style_radius(disc, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(disc, LV_OPA_COVER, 0);
    discIcon = makeLabel(disc, &font_icon_104, COLOR_TEXT);
    lv_obj_center(discIcon);

    plainIcon = makeLabel(column, &font_icon_104, COLOR_TEXT);

    title = makeLabel(column, &font_title_46, COLOR_TEXT);
    lv_obj_set_width(title, contentWidth);

    subtitle = makeLabel(column, &font_text_20, COLOR_TEXT_MUTED);
    lv_obj_set_width(subtitle, contentWidth);

    bar = lv_bar_create(column);
    lv_obj_set_clickable(bar, false);
    lv_obj_set_size(bar, contentWidth, 10);
    lv_bar_set_range(bar, 0, BAR_RANGE);
    lv_obj_set_style_radius(bar, 5, LV_PART_MAIN);
    lv_obj_set_style_bg_color(bar, lv_color_hex(COLOR_TRACK), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_radius(bar, 5, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(bar, lv_color_hex(COLOR_YELLOW), LV_PART_INDICATOR);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, LV_PART_INDICATOR);
    lv_obj_set_style_margin_top(bar, 8, 0);

    countdownLabel = makeLabel(column, &font_text_17, COLOR_TEXT_MUTED);
    lv_obj_set_width(countdownLabel, contentWidth);
    lv_obj_set_style_margin_top(countdownLabel, -6, 0);

    // Feld unten: Hinweis auf den Tipp
    footer = makeBox(root);
    lv_obj_set_size(footer, contentWidth, FOOTER_HEIGHT);
    lv_obj_align(footer, LV_ALIGN_BOTTOM_MID, 0, -PADDING);
    lv_obj_set_style_radius(footer, 16, 0);
    lv_obj_set_style_border_width(footer, 2, 0);
    lv_obj_set_style_border_opa(footer, LV_OPA_COVER, 0);
    footerLabel = makeLabel(footer, &font_text_17, COLOR_TEXT);
    lv_obj_center(footerLabel);

    show(Screen::Free);
}

void show(Screen screen) {
    currentScreen = screen;
    const ScreenSpec &spec = SPECS[static_cast<uint8_t>(screen)];

    lv_obj_set_hidden(disc, !spec.onDisc);
    lv_obj_set_hidden(plainIcon, spec.onDisc);
    if (spec.onDisc) {
        lv_obj_set_size(disc, spec.discSize, spec.discSize);
        lv_obj_set_style_bg_color(disc, lv_color_hex(spec.accent), 0);
        lv_obj_set_style_text_color(discIcon, lv_color_hex(spec.onAccent), 0);
        lv_label_set_text(discIcon, spec.icon);
    } else {
        lv_obj_set_style_text_color(plainIcon, lv_color_hex(spec.accent), 0);
        lv_label_set_text(plainIcon, spec.icon);
    }

    lv_obj_set_style_text_font(title, spec.titleFont, 0);
    lv_obj_set_style_text_line_space(title, spec.titleLineSpace, 0);
    lv_label_set_text(title, spec.title);
    lv_label_set_text(subtitle, spec.subtitle);

    lv_obj_set_hidden(bar, !spec.countdown);
    lv_obj_set_hidden(countdownLabel, !spec.countdown);
    if (spec.countdown) {
        shownSeconds = UINT32_MAX;
        lv_bar_set_value(bar, BAR_RANGE, LV_ANIM_OFF);
        lv_label_set_text(countdownLabel, "");
    }

    lv_obj_set_hidden(footer, spec.footer == nullptr);
    if (spec.footer != nullptr) {
        lv_obj_set_style_border_color(footer, lv_color_hex(spec.footerBorder), 0);
        lv_label_set_text(footerLabel, spec.footer);
    }
}

Screen current() {
    return currentScreen;
}

void setCountdown(uint32_t remainingMs, uint32_t totalMs) {
    if (totalMs == 0) {
        return;
    }
    if (remainingMs > totalMs) {
        remainingMs = totalMs;
    }
    lv_bar_set_value(bar, static_cast<int32_t>(
                              static_cast<uint64_t>(remainingMs) * BAR_RANGE / totalMs),
                     LV_ANIM_OFF);

    const uint32_t seconds = (remainingMs + 999) / 1000;
    if (seconds != shownSeconds) {
        shownSeconds = seconds;
        if (seconds == 1) {
            lv_label_set_text(countdownLabel, "noch 1 Sekunde");
        } else {
            lv_label_set_text_fmt(countdownLabel, "noch %lu Sekunden",
                                  static_cast<unsigned long>(seconds));
        }
    }
}

void setOnline(bool online) {
    lv_label_set_text(statusIcon, online ? ICON_WIFI : ICON_WIFI_OFF);
}

}  // namespace ui
