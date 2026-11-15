import type { Door } from "./door";

export interface Env {
  DOOR: DurableObjectNamespace<Door>;
  // Geheime Schluessel, gesetzt als Worker-Secrets bzw. in .dev.vars
  DEVICE_KEY?: string;
  APP_KEY?: string;
  // Frist fuer Anfragen in Sekunden, aus wrangler.jsonc
  ANFRAGE_FRIST_S?: string;
}
