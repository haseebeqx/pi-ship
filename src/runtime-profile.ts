import { isAbsolute } from "node:path";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Generic process and host policy for Pi and applications built around it. */
export interface RuntimeProfile {
  /** Non-secret variables inherited by Pi. Put credentials in secretFiles instead. */
  environment?: Record<string, string>;
  /** Non-secret application configuration, exposed through PI_SHIP_RUNTIME_CONFIG. */
  configuration?: JsonValue;
  /** Extra directories visible through the hardened service sandbox. */
  readOnlyDirectories?: readonly string[];
  /** Extra directories writable through the hardened service sandbox. */
  readWriteDirectories?: readonly string[];
  /** Additional Pi CLI arguments. */
  piArgs?: readonly string[];
  /** Pi built-in tool allowlist (for example ["read", "bash"]). */
  tools?: readonly string[];
  /** Initial model used when a session has not selected one. */
  model?: { provider: string; id: string };
  resources?: {
    memoryMaxBytes?: number;
    cpuQuotaPercent?: number;
    tasksMax?: number;
    maxSessions?: number;
    maxConcurrentSessions?: number;
    maxQueueSizePerSession?: number;
    maxTotalQueueSize?: number;
    idleTimeoutMs?: number;
  };
}

/** Secret payload kept separately from RuntimeProfile and the workspace. */
export interface RuntimeSecrets {
  /** Secret variables inherited by Pi without appearing in ShipConfig or status. */
  environment?: Record<string, string>;
  /** Files are installed as 0640 under /etc/pi-ship/secrets.d. Keys are filenames. */
  secretFiles?: Record<string, string>;
}

export function validateRuntimeProfile(profile: RuntimeProfile | undefined): void {
  if (!profile) return;
  for (const [name, value] of Object.entries(profile.environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid runtime environment variable name: ${name}`);
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`Invalid runtime environment value for ${name}`);
  }
  for (const path of [...(profile.readOnlyDirectories ?? []), ...(profile.readWriteDirectories ?? [])]) {
    if (!isAbsolute(path) || path.includes("\0") || path.includes("\n")) throw new Error("Runtime directories must be absolute paths without newlines");
  }
  for (const value of profile.piArgs ?? []) if (!value || value.includes("\0")) throw new Error("Pi arguments must be non-empty strings");
  for (const tool of profile.tools ?? []) if (!/^[A-Za-z0-9_-]+$/.test(tool)) throw new Error(`Invalid Pi tool name: ${tool}`);
  if (profile.model && (!profile.model.provider || !profile.model.id)) throw new Error("Runtime model requires provider and id");
  const positive = ["memoryMaxBytes", "cpuQuotaPercent", "tasksMax", "maxSessions", "maxConcurrentSessions", "maxQueueSizePerSession", "maxTotalQueueSize"] as const;
  for (const name of positive) {
    const value = profile.resources?.[name];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error(`${name} must be a positive integer`);
  }
  const idle = profile.resources?.idleTimeoutMs;
  if (idle !== undefined && (!Number.isInteger(idle) || idle < 0)) throw new Error("idleTimeoutMs must be a non-negative integer");
}

export function validateRuntimeSecrets(secrets: RuntimeSecrets | undefined): void {
  for (const [name, value] of Object.entries(secrets?.environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid secret environment variable name: ${name}`);
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`Invalid secret environment variable: ${name}`);
  }
  for (const [name, value] of Object.entries(secrets?.secretFiles ?? {})) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name === "." || name === "..") throw new Error(`Invalid secret filename: ${name}`);
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`Invalid secret file: ${name}`);
  }
}

/** Arguments owned by the profile. Callers may append session/mode arguments. */
export function runtimePiArgs(profile: RuntimeProfile | undefined): string[] {
  const args = [...(profile?.piArgs ?? [])];
  if (profile?.tools) args.push("--tools", profile.tools.join(","));
  if (profile?.model) args.push("--provider", profile.model.provider, "--model", profile.model.id);
  return args;
}
