import { readFile } from "node:fs/promises";
import type { RuntimeProfile, RuntimeSecrets } from "./runtime-profile.js";

export type InteractiveSessionMode = "ephemeral" | "persistent";

export interface ShipConfig {
  name: string;
  workspace: string;
  agentDir: string;
  /** Default used by `pi-ship pi` when no Pi arguments are supplied. */
  interactiveSessionMode?: InteractiveSessionMode;
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

export function validateInteractiveSessionMode(value: string): asserts value is InteractiveSessionMode {
  if (value !== "ephemeral" && value !== "persistent") {
    throw new Error(`Unsupported interactive session mode: ${value}`);
  }
}

/** Pi arguments used for an argument-free interactive connection. */
export function defaultInteractivePiArgs(config: ShipConfig): string[] {
  return config.interactiveSessionMode === "persistent"
    ? ["--approve"]
    : ["--no-session", "--approve"];
}

