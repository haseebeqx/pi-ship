import { readFile } from "node:fs/promises";

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
}

export interface ShipSecrets {
  telegram?: {
    botToken: string;
  };
  slack?: {
    botToken: string;
    appToken: string;
  };
}

export async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

