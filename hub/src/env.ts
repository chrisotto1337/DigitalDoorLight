import type { Door } from "./door";

export interface Env {
  DOOR: DurableObjectNamespace<Door>;
  // Geheime Schluessel, gesetzt als Worker-Secrets bzw. in .dev.vars
  DEVICE_KEY?: string;
  APP_KEY?: string;
  // Frist fuer Anfragen in Sekunden, aus wrangler.jsonc
  ANFRAGE_FRIST_S?: string;
  // Nur fuer lokale Tests: "1" erlaubt Push-Ziele auf 127.0.0.1
  PUSH_LOKAL_ERLAUBT?: string;
  // Dateien aus public/, auch die Firmware unter /firmware/
  ASSETS: Fetcher;
  // Firmware, die der Hub anbietet. Setzt der Workflow beim Ausrollen.
  FIRMWARE_VERSION?: string;
  FIRMWARE_MD5?: string;
}
