#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadJson, type ShipConfig, type ShipSecrets } from "./config.js";
import { runtimePiArgs, validateRuntimeProfile, validateRuntimeSecrets } from "./runtime-profile.js";

const configPath = process.env.PI_SHIP_CONFIG ?? "/etc/pi-ship/config.json";
const secretsPath = process.env.PI_SHIP_SECRETS ?? "/etc/pi-ship/secrets.json";
const config = await loadJson<ShipConfig>(configPath);
const secrets = await loadJson<ShipSecrets>(secretsPath);
validateRuntimeProfile(config.runtime);
validateRuntimeSecrets(secrets.runtime);

await mkdir(config.workspace, { recursive: true });
await mkdir(config.agentDir, { recursive: true });

const piModule = import.meta.resolve("@earendil-works/pi-coding-agent");
const cliPath = fileURLToPath(new URL("cli.js", piModule));
const forwardedArgs = process.argv.slice(2);
const piArgs = [...runtimePiArgs(config.runtime), ...(forwardedArgs.length > 0 ? forwardedArgs : ["--no-session", "--approve"])];
const child = spawn(process.execPath, [cliPath, ...piArgs], {
  cwd: config.workspace,
  env: {
    ...process.env,
    ...config.runtime?.environment,
    ...secrets.runtime?.environment,
    PI_CODING_AGENT_DIR: config.agentDir,
    PI_SHIP_RUNTIME_CONFIG: "/etc/pi-ship/runtime-config.json",
    PI_SHIP_SECRET_DIR: "/etc/pi-ship/secrets.d",
  },
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(`Could not start Pi: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
