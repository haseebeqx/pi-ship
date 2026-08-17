#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { exposeModelCredential, loadJson, type ShipConfig, type ShipSecrets } from "./config.js";

const configPath = process.env.PI_SHIP_CONFIG ?? "/etc/pi-ship/config.json";
const secretsPath = process.env.PI_SHIP_SECRETS ?? "/etc/pi-ship/secrets.json";
const config = await loadJson<ShipConfig>(configPath);
const secrets = await loadJson<ShipSecrets>(secretsPath);
exposeModelCredential(secrets);

await mkdir(config.workspace, { recursive: true });
await mkdir(config.agentDir, { recursive: true });

const piModule = import.meta.resolve("@earendil-works/pi-coding-agent");
const cliPath = fileURLToPath(new URL("cli.js", piModule));
const child = spawn(process.execPath, [
  cliPath,
  "--no-session",
  "--provider", secrets.model.provider,
  "--approve",
], {
  cwd: config.workspace,
  env: { ...process.env, PI_CODING_AGENT_DIR: config.agentDir },
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
