#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadJson, type ShipConfig } from "./config.js";

const configPath = process.env.PI_SHIP_CONFIG ?? "/etc/pi-ship/config.json";
const config = await loadJson<ShipConfig>(configPath);

await mkdir(config.workspace, { recursive: true });
await mkdir(config.agentDir, { recursive: true });

const piModule = import.meta.resolve("@earendil-works/pi-coding-agent");
const cliPath = fileURLToPath(new URL("cli.js", piModule));
const forwardedArgs = process.argv.slice(2);
const piArgs = forwardedArgs.length > 0 ? forwardedArgs : ["--no-session", "--approve"];
const child = spawn(process.execPath, [cliPath, ...piArgs], {
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
