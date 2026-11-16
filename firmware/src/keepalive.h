#pragma once

// Haelt eine USB-Powerbank wach.
//
// Viele Powerbanks schalten ab, wenn das Geraet wenig Strom zieht. Das Board
// zieht deshalb in festem Takt kurz mehr: Rechenlast auf dem zweiten
// Prozessorkern und ein Schwung WLAN-Pakete an den Router. Unsichtbar, laeuft
// auch bei dunklem Display. Einstellungen in config.h.
namespace keepalive {

void begin();

}  // namespace keepalive
