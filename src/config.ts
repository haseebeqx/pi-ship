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
  };
}

export interface ShipSecrets {
  model: {
    provider: "anthropic" | "openai" | "google";
    apiKey: string;
  };
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

export function exposeModelCredential(secrets: ShipSecrets): void {
  const names: Record<ShipSecrets["model"]["provider"], string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GEMINI_API_KEY",
  };
  process.env[names[secrets.model.provider]] = secrets.model.apiKey;
}
