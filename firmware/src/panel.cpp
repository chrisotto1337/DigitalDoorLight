#include "panel.h"

#include <lvgl.h>

#include "config.h"

namespace panel {

namespace {

LilyGo_Class amoled;
bool on = true;

}  // namespace

bool begin() {
    if (!amoled.begin()) {
        return false;
    }
    amoled.setRotation(config::DISPLAY_ROTATION);
    amoled.setBrightness(config::DISPLAY_BRIGHTNESS);
    return true;
}

LilyGo_Class &device() {
    return amoled;
}

void setOn(bool value) {
    if (value == on) {
        return;
    }
    on = value;
    if (value) {
        amoled.disp_wakeup();
        // Das Panel braucht nach dem Aufwachen 120 ms, bevor es Daten annimmt.
        delay(120);
        // Erst neu zeichnen, dann hell: sonst blitzt kurz das alte Bild auf.
        lv_obj_invalidate(lv_screen_active());
        lv_refr_now(nullptr);
        amoled.setBrightness(config::DISPLAY_BRIGHTNESS);
    } else {
        amoled.setBrightness(0);
        amoled.disp_sleep();
    }
    Serial.printf("[panel] %s\n", value ? "an" : "aus");
}

bool isOn() {
    return on;
}

}  // namespace panel
