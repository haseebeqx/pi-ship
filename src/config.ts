import { readFile } from "node:fs/promises";
import type { RuntimeProfile, RuntimeSecrets } from "./runtime-profile.js";

export interface ShipConfig {
  name: string;
  workspace: string;
  agentDir: string;
  telegram?: {
    pairingCodeHash: string;
    statePath: string;
  };
  slack?: {
    socketMode: true;
    pairingCodeHash: string;
    statePath: string;
  };
  /** Consumer-defined runtime policy; never contains secret values. */
  runtime?: RuntimeProfile;
}

export interface ShipSecrets {
  telegram?: {
    botToken: string;
  };
  slack?: {
    botToken: string;
    appToken: string;
  };
  /** Kept in the protected secrets document, separate from ShipConfig. */
  runtime?: RuntimeSecrets;
}

export async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

