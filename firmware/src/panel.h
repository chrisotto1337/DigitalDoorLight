#pragma once

#include <LilyGo_AMOLED.h>

// Das AMOLED selbst: einschalten, ausschalten, Helligkeit.
namespace panel {

bool begin();
LilyGo_Class &device();

// Ganz aus oder wieder an. Der Touch bleibt dabei aktiv.
void setOn(bool on);
bool isOn();

}  // namespace panel
