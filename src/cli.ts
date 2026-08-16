#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface, emitKeypressEvents } from "node:readline";
import { hashPairingCode } from "./pairing.js";
import { resolveServer, saveServer } from "./inventory.js";
import { run, shellQuote } from "./process.js";
import { compareVersions, validateVersion } from "./version.js";
import type { ShipConfig, ShipSecrets } from "./config.js";

const [command = "help", ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "deploy": await deploy(args); break;
    case "update": await update(args); break;
    case "status": await status(args); break;
    case "logs": await logs(args); break;
    case "help":
    case "--help":
    case "-h": printHelp(); break;
    default: throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(`\nError: ${(error as Error).message}`);
  process.exitCode = 1;
}

async function deploy(args: string[]): Promise<void> {
  const target = positional(args, 0) ?? await prompt("SSH server (user@host): ");
  const name = option(args, "--name") ?? (await prompt("Name this Pi [my-pi]: ") || "my-pi");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(name)) {
    throw new Error("The name must contain only letters, numbers, _ or -, and be at most 32 characters.");
  }

  const providerInput = option(args, "--provider") ?? (await prompt("Model provider [anthropic/openai/google] (anthropic): ") || "anthropic");
  if (!isProvider(providerInput)) throw new Error(`Unsupported model provider: ${providerInput}`);
  const modelApiKey = process.env.PI_SHIP_MODEL_API_KEY ?? await promptSecret(`${providerInput} API key: `);
  const channel = option(args, "--channel") ?? (await prompt("Communication channel [telegram/slack] (telegram): ") || "telegram");
  if (channel !== "telegram" && channel !== "slack") throw new Error(`Unsupported communication channel: ${channel}`);

  const pairingCode = randomBytes(5).toString("hex").toUpperCase();
  const config: ShipConfig = {
    name,
    workspace: "/var/lib/pi-ship/workspace",
    agentDir: "/var/lib/pi-ship/agent",
  };
  const secrets: ShipSecrets = {
    model: { provider: providerInput, apiKey: modelApiKey },
  };
  if (channel === "telegram") {
    const botToken = process.env.PI_SHIP_TELEGRAM_TOKEN ?? await promptSecret("Telegram bot token: ");
    if (!modelApiKey || !botToken) throw new Error("Model and Telegram credentials are required.");
    config.telegram = {
      pairingCodeHash: hashPairingCode(pairingCode),
      statePath: "/var/lib/pi-ship/telegram-state.json",
    };
    secrets.telegram = { botToken };
  } else {
    const botToken = process.env.PI_SHIP_SLACK_BOT_TOKEN ?? await promptSecret("Slack bot token (xoxb-): ");
    const appToken = process.env.PI_SHIP_SLACK_APP_TOKEN ?? await promptSecret("Slack Socket Mode app token (xapp-): ");
    if (!modelApiKey || !botToken || !appToken) throw new Error("Model and Slack credentials are required.");
    config.slack = { socketMode: true };
    secrets.slack = { botToken, appToken };
  }

  const temporary = await mkdtemp(join(tmpdir(), "pi-ship-"));
  try {
    const root = packageRoot();
    const archive = join(temporary, "pi-ship.tgz");
    const configFile = join(temporary, "config.json");
    const secretsFile = join(temporary, "secrets.json");
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await writeFile(secretsFile, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
    await chmod(secretsFile, 0o600);

    console.log("\nPreparing Pi Ship...");
    await createArchive(root, archive);

    const remoteDir = `/tmp/pi-ship-${randomBytes(6).toString("hex")}`;
    await run("ssh", [target, `install -d -m 700 ${shellQuote(remoteDir)}`]);
    await run("scp", [archive, configFile, secretsFile, join(root, "scripts", "install.sh"), `${target}:${remoteDir}/`]);

    console.log("Installing and securing Pi on the server...");
    const version = await localVersion(root);
    const install = `${remoteDir}/install.sh install ${remoteDir}/pi-ship.tgz ${remoteDir}/config.json ${remoteDir}/secrets.json ${shellQuote(version)}`;
    const elevate = `if [ \"$(id -u)\" = 0 ]; then bash ${install}; else sudo -n bash ${install}; fi`;
    await run("ssh", [target, elevate]);
    await saveServer(name, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  console.log(`\n✓ ${name} is online`);
  if (channel === "telegram") {
    console.log("\nOpen your Telegram bot and send:");
    console.log(`  /pair ${pairingCode}`);
  } else {
    console.log("\nMention the installed Slack app in a channel, or send it a direct message.");
  }
  console.log(`\nCheck it later with: pi-ship status ${name}`);
}

async function update(args: string[]): Promise<void> {
  const name = positional(args, 0);
  if (!name) throw new Error("Usage: pi-ship update <name-or-user@host>");
  const target = await resolveServer(name);
  const root = packageRoot();
  const available = await localVersion(root);
  const installed = (await run("ssh", [target, "cat /opt/pi-ship/version"], { capture: true })).trim();

  if (compareVersions(available, installed) <= 0) {
    console.log(`No update needed: server has ${installed}, local runtime is ${available}.`);
    return;
  }

  const temporary = await mkdtemp(join(tmpdir(), "pi-ship-update-"));
  try {
    const archive = join(temporary, "pi-ship.tgz");
    await createArchive(root, archive);
    const remoteDir = `/tmp/pi-ship-${randomBytes(6).toString("hex")}`;
    await run("ssh", [target, `install -d -m 700 ${shellQuote(remoteDir)}`]);
    await run("scp", [archive, join(root, "scripts", "install.sh"), `${target}:${remoteDir}/`]);
    console.log(`Updating ${name} from ${installed} to ${available}...`);
    const install = `${remoteDir}/install.sh update ${remoteDir}/pi-ship.tgz ${shellQuote(available)} ${shellQuote(installed)}`;
    const elevate = `if [ \"$(id -u)\" = 0 ]; then bash ${install}; else sudo -n bash ${install}; fi`;
    await run("ssh", [target, elevate]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(`✓ ${name} is running Pi Ship ${available}`);
}

async function status(args: string[]): Promise<void> {
  const name = positional(args, 0);
  if (!name) throw new Error("Usage: pi-ship status <name-or-user@host>");
  const target = await resolveServer(name);
  const output = await run("ssh", [target, "printf 'Runtime version: '; cat /opt/pi-ship/version && sudo -n systemctl is-active pi-ship.service && sudo -n systemctl --no-pager --full status pi-ship.service | head -n 12"], { capture: true });
  process.stdout.write(output);
}

async function logs(args: string[]): Promise<void> {
  const name = positional(args, 0);
  if (!name) throw new Error("Usage: pi-ship logs <name-or-user@host>");
  const target = await resolveServer(name);
  await run("ssh", ["-t", target, "sudo -n journalctl -u pi-ship.service -n 100 -f"]);
}

function printHelp(): void {
  console.log(`pi-ship

  deploy [user@host]   Install an always-running Pi with Telegram or Slack
  update <name>        Install the local runtime when it is newer than the server
  status <name>        Show the runtime version and whether Pi is online
  logs <name>          Follow Pi's logs

Credentials can be supplied non-interactively through:
  PI_SHIP_MODEL_API_KEY
  PI_SHIP_TELEGRAM_TOKEN
  PI_SHIP_SLACK_BOT_TOKEN
  PI_SHIP_SLACK_APP_TOKEN`);
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function localVersion(root: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error("package.json does not contain a version");
  validateVersion(manifest.version);
  return manifest.version;
}

async function createArchive(root: string, archive: string): Promise<void> {
  await run("tar", ["-czf", archive, "--exclude=node_modules", "--exclude=src", "--exclude=test", "-C", root, "package.json", "dist", "scripts", "README.md"]);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[], index: number): string | undefined {
  return args.filter((arg, i) => !arg.startsWith("--") && (i === 0 || !args[i - 1]?.startsWith("--")))[index];
}

function isProvider(value: string): value is ShipSecrets["model"]["provider"] {
  return value === "anthropic" || value === "openai" || value === "google";
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePrompt) => rl.question(question, (answer) => {
    rl.close();
    resolvePrompt(answer.trim());
  }));
}

async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`Cannot prompt for ${question.trim()} without a terminal; use environment variables.`);
  process.stdout.write(question);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  return new Promise((resolveSecret, reject) => {
    let value = "";
    const onKey = (text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Cancelled"));
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        process.stdout.write("\n");
        resolveSecret(value);
      } else if (key.name === "backspace") {
        value = value.slice(0, -1);
      } else if (!key.ctrl && text && !/^\u001b/.test(text)) {
        value += text;
      }
    };
    const cleanup = () => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
    };
    process.stdin.on("keypress", onKey);
  });
}
