#pragma once

// Ablauf der Tuerampel: verbindet Anzeige, Touch und Hub.
namespace controller {

void begin();
void loop();

// Wie ein Tipp irgendwo auf das Display, etwa vom BOOT-Taster.
void tap();

}  // namespace controller
