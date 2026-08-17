#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface, emitKeypressEvents } from "node:readline";
import { hashPairingCode } from "./pairing.js";
import { resolveServer, saveServer } from "./inventory.js";
import type { ServerConnection } from "./inventory.js";
import { run, shellQuote } from "./process.js";
import { compareVersions, validateVersion } from "./version.js";
import type { ShipConfig, ShipSecrets } from "./config.js";

const [command = "help", ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "deploy": await deploy(args); break;
    case "pi": await runPi(args); break;
    case "update": await update(args); break;
    case "update-pi": await updatePi(args); break;
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
  const options = parseOptions(args, [
    "--server", "--certificate", "--name", "--channel",
    "--telegram-bot-token", "--slack-bot-token", "--slack-app-token",
  ]);
  const interactive = process.stdin.isTTY && process.stdout.isTTY && deployNeedsInput(options);
  const target = await required(options, "--server", "SSH server (user@host): ");
  const certificate = options.get("--certificate")
    ?? (interactive ? await prompt("SSH identity file (optional, press Enter to use password/agent): ") : undefined);
  const name = await required(options, "--name", "Name this Pi", { defaultValue: "my-pi" });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(name)) {
    throw new Error("The name must contain only letters, numbers, _ or -, and be at most 32 characters.");
  }

  const channel = options.get("--channel") ?? "connect";
  if (channel !== "connect" && channel !== "telegram" && channel !== "slack") {
    throw new Error(`Unsupported communication channel: ${channel}`);
  }
  const connection: ServerConnection = {
    target,
    certificate: certificate ? resolveIdentityFile(certificate) : undefined,
  };

  const pairingCode = channel === "connect" ? undefined : randomBytes(5).toString("hex").toUpperCase();
  const config: ShipConfig = {
    name,
    workspace: "/var/lib/pi-ship/workspace",
    agentDir: "/var/lib/pi-ship/agent",
  };
  const secrets: ShipSecrets = {};
  if (channel === "telegram") {
    const botToken = options.get("--telegram-bot-token") ?? process.env.PI_SHIP_TELEGRAM_TOKEN
      ?? await required(options, "--telegram-bot-token", "Telegram bot token: ", { secret: true });
    config.telegram = {
      pairingCodeHash: hashPairingCode(pairingCode!),
      statePath: "/var/lib/pi-ship/telegram-state.json",
    };
    secrets.telegram = { botToken };
  } else if (channel === "slack") {
    const botToken = options.get("--slack-bot-token") ?? process.env.PI_SHIP_SLACK_BOT_TOKEN
      ?? await required(options, "--slack-bot-token", "Slack bot token (xoxb-): ", { secret: true });
    const appToken = options.get("--slack-app-token") ?? process.env.PI_SHIP_SLACK_APP_TOKEN
      ?? await required(options, "--slack-app-token", "Slack Socket Mode app token (xapp-): ", { secret: true });
    config.slack = {
      socketMode: true,
      pairingCodeHash: hashPairingCode(pairingCode!),
      statePath: "/var/lib/pi-ship/slack-state.json",
    };
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
    await run("ssh", sshArgs(connection, `install -d -m 700 ${shellQuote(remoteDir)}`));
    await run("scp", scpArgs(connection, archive, configFile, secretsFile, join(root, "scripts", "install.sh"), `${target}:${remoteDir}/`));

    console.log("Installing and securing Pi on the server...");
    const version = await localVersion(root);
    const install = `${remoteDir}/install.sh install ${remoteDir}/pi-ship.tgz ${remoteDir}/config.json ${remoteDir}/secrets.json ${shellQuote(version)}`;
    const elevate = `if [ \"$(id -u)\" = 0 ]; then bash ${install}; else sudo -n bash ${install}; fi`;
    await run("ssh", sshArgs(connection, withRemoteCleanup(remoteDir, elevate)));
    await saveServer(name, connection);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  console.log(`\n✓ ${name} is installed`);
  if (channel === "telegram") {
    console.log("\nOpen your Telegram bot and send:");
    console.log(`  /pair ${pairingCode}`);
  } else if (channel === "slack") {
    console.log("\nSend this direct message to the installed Slack app:");
    console.log(`  /pair ${pairingCode}`);
    console.log("\nAfter pairing, that Slack user can mention the app in channels or send direct messages.");
  } else {
    console.log("\nPi will run only while you are connected. Start a one-off session with:");
    console.log(`  pi-ship pi --server ${name}`);
  }
  console.log(`\nCheck it later with: pi-ship status --server ${name}`);
}

async function runPi(args: string[]): Promise<void> {
  const { shipArgs, piArgs } = splitPiArgs(args);
  const options = parseOptions(shipArgs, ["--server", "--certificate"]);
  const server = await required(options, "--server", "Server (saved name or user@host): ");
  const connection = await resolveServer(server, certificateOption(options));
  const executable = "sudo -n -u pi-ship env HOME=/var/lib/pi-ship PATH=/opt/pi-ship/node/bin:/usr/local/bin:/usr/bin:/bin PI_SHIP_CONFIG=/etc/pi-ship/config.json /opt/pi-ship/app/bin/pi-ship-pi";
  const remoteCommand = [executable, ...piArgs.map(shellQuote)].join(" ");
  const ttyArgs = process.stdin.isTTY && process.stdout.isTTY ? ["-t"] : [];
  await run("ssh", sshArgs(connection, ...ttyArgs, remoteCommand));
}

async function update(args: string[]): Promise<void> {
  const options = parseOptions(args, ["--server", "--certificate"]);
  const name = await required(options, "--server", "Server (saved name or user@host): ");
  const connection = await resolveServer(name, certificateOption(options));
  const { target } = connection;
  const root = packageRoot();
  const available = await localVersion(root);
  const installed = (await run("ssh", sshArgs(connection, "cat /opt/pi-ship/version"), { capture: true })).trim();

  if (compareVersions(available, installed) <= 0) {
    console.log(`No update needed: server has ${installed}, local runtime is ${available}.`);
    return;
  }

  const temporary = await mkdtemp(join(tmpdir(), "pi-ship-update-"));
  try {
    const archive = join(temporary, "pi-ship.tgz");
    await createArchive(root, archive);
    const remoteDir = `/tmp/pi-ship-${randomBytes(6).toString("hex")}`;
    await run("ssh", sshArgs(connection, `install -d -m 700 ${shellQuote(remoteDir)}`));
    await run("scp", scpArgs(connection, archive, join(root, "scripts", "install.sh"), `${target}:${remoteDir}/`));
    console.log(`Updating ${name} from ${installed} to ${available}...`);
    const install = `${remoteDir}/install.sh update ${remoteDir}/pi-ship.tgz ${shellQuote(available)} ${shellQuote(installed)}`;
    const elevate = `if [ \"$(id -u)\" = 0 ]; then bash ${install}; else sudo -n bash ${install}; fi`;
    await run("ssh", sshArgs(connection, withRemoteCleanup(remoteDir, elevate)));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(`✓ ${name} has Pi Ship ${available}`);
}

async function updatePi(args: string[]): Promise<void> {
  const options = parseOptions(args, ["--server", "--certificate", "--version"]);
  const name = await required(options, "--server", "Server (saved name or user@host): ");
  const connection = await resolveServer(name, certificateOption(options));
  const packageName = "@earendil-works/pi-coding-agent";
  const installedCommand = `/opt/pi-ship/node/bin/node -p ${shellQuote(`require('/opt/pi-ship/app/lib/node_modules/pi-ship/node_modules/${packageName}/package.json').version`)}`;
  const installed = (await run("ssh", sshArgs(connection, installedCommand), { capture: true })).trim();
  validateVersion(installed);

  const requested = options.get("--version");
  const available = requested
    ?? (await run("npm", ["view", `${packageName}@latest`, "version"], { capture: true })).trim();
  validateVersion(available);
  if (compareVersions(available, installed) <= 0) {
    console.log(`No Pi update needed: server has ${installed}, requested version is ${available}.`);
    return;
  }

  const remoteDir = `/tmp/pi-ship-${randomBytes(6).toString("hex")}`;
  await run("ssh", sshArgs(connection, `install -d -m 700 ${shellQuote(remoteDir)}`));
  await run("scp", scpArgs(connection, join(packageRoot(), "scripts", "install.sh"), `${connection.target}:${remoteDir}/`));
  console.log(`Updating Pi on ${name} from ${installed} to ${available}...`);
  const install = `${remoteDir}/install.sh update-pi ${shellQuote(available)} ${shellQuote(installed)}`;
  const elevate = `if [ \"$(id -u)\" = 0 ]; then bash ${install}; else sudo -n bash ${install}; fi`;
  await run("ssh", sshArgs(connection, withRemoteCleanup(remoteDir, elevate)));
  console.log(`✓ ${name} has Pi ${available}`);
}

async function status(args: string[]): Promise<void> {
  const options = parseOptions(args, ["--server", "--certificate"]);
  const server = await required(options, "--server", "Server (saved name or user@host): ");
  const connection = await resolveServer(server, certificateOption(options));
  const remoteCommand = "printf 'Runtime version: '; cat /opt/pi-ship/version; printf 'Pi version: '; /opt/pi-ship/node/bin/node -p \"require('/opt/pi-ship/app/lib/node_modules/pi-ship/node_modules/@earendil-works/pi-coding-agent/package.json').version\" && if sudo -n systemctl is-enabled --quiet pi-ship.service; then printf 'Mode: communication provider (persistent)\\n'; sudo -n systemctl is-active pi-ship.service; sudo -n systemctl --no-pager --full status pi-ship.service | head -n 12; else printf 'Mode: connect (on demand)\\n'; fi";
  const output = await run("ssh", sshArgs(connection, remoteCommand), { capture: true });
  process.stdout.write(output);
}

async function logs(args: string[]): Promise<void> {
  const options = parseOptions(args, ["--server", "--certificate"]);
  const server = await required(options, "--server", "Server (saved name or user@host): ");
  const connection = await resolveServer(server, certificateOption(options));
  await run("ssh", sshArgs(connection, "-t", "sudo -n journalctl -u pi-ship.service -n 100 -f"));
}

function printHelp(): void {
  console.log(`pi-ship

  deploy --server <user@host> --name <name>
         [--channel <telegram|slack> [channel credentials]] [--certificate <path>]
  pi      --server <name-or-user@host> [--certificate <path>] [-- <pi-args...>]
  update    --server <name-or-user@host> [--certificate <path>]
  update-pi --server <name-or-user@host> [--certificate <path>] [--version <semver>]
  status    --server <name-or-user@host> [--certificate <path>]
  logs   --server <name-or-user@host> [--certificate <path>]

Deploy channel credentials:
  Telegram: --telegram-bot-token <token>
  Slack:    --slack-bot-token <token> --slack-app-token <token>

Without --channel, Pi runs only for one-off sessions opened by pi.
Arguments after -- are passed directly to Pi; for example: pi-ship pi --server my-pi -- install npm:@foo/bar
Missing required options are prompted for when running in a terminal.
Authenticate model providers from Pi with /login. Channel credentials may also
be supplied through PI_SHIP_TELEGRAM_TOKEN, PI_SHIP_SLACK_BOT_TOKEN, and
PI_SHIP_SLACK_APP_TOKEN.
The certificate is used as the SSH identity file. A certificate supplied during
deploy is saved with the named server for later pi, update, update-pi, status, and logs calls.`);
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
  // npm package tarballs must contain a top-level `package/` directory.
  const staging = await mkdtemp(join(tmpdir(), "pi-ship-package-"));
  const packageDirectory = join(staging, "package");
  try {
    await mkdir(packageDirectory);
    for (const entry of ["package.json", "npm-shrinkwrap.json", "dist", "scripts", "README.md"]) {
      await cp(join(root, entry), join(packageDirectory, entry), { recursive: true });
    }
    await run("tar", ["-czf", archive, "-C", staging, "package"]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function splitPiArgs(args: string[]): { shipArgs: string[]; piArgs: string[] } {
  const shipArgs: string[] = [];
  const shipOptions = new Set(["--server", "--certificate"]);

  for (let index = 0; index < args.length;) {
    const arg = args[index]!;
    if (arg === "--") return { shipArgs, piArgs: args.slice(index + 1) };
    if (!shipOptions.has(arg)) return { shipArgs, piArgs: args.slice(index) };

    shipArgs.push(arg);
    const value = args[index + 1];
    if (value !== undefined && value !== "--" && !value.startsWith("--")) {
      shipArgs.push(value);
      index += 2;
    } else {
      index += 1;
    }
  }

  return { shipArgs, piArgs: [] };
}

function parseOptions(args: string[], allowed: string[]): Map<string, string> {
  const options = new Map<string, string>();
  const seen = new Set<string>();
  for (let index = 0; index < args.length;) {
    const name = args[index];
    if (!name?.startsWith("--")) throw new Error(`Unexpected positional argument: ${name}`);
    if (!allowed.includes(name)) throw new Error(`Unknown option: ${name}`);
    if (seen.has(name)) throw new Error(`Option supplied more than once: ${name}`);
    seen.add(name);

    const value = args[index + 1];
    if (value !== undefined && !value.startsWith("--")) {
      options.set(name, value);
      index += 2;
    } else {
      // A valueless known option is treated like an omitted option and prompted for.
      index += 1;
    }
  }
  return options;
}

interface PromptOptions {
  defaultValue?: string;
  secret?: boolean;
}

async function required(
  options: Map<string, string>,
  name: string,
  question: string,
  promptOptions: PromptOptions = {},
): Promise<string> {
  const supplied = options.get(name);
  if (supplied) return supplied;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Missing required option: ${name} (cannot prompt without a terminal)`);
  }

  const suffix = promptOptions.defaultValue ? ` [${promptOptions.defaultValue}]: ` : question.endsWith(" ") ? "" : ": ";
  while (true) {
    const answer = promptOptions.secret
      ? await promptSecret(question)
      : await prompt(`${question}${suffix}`);
    const value = answer || promptOptions.defaultValue;
    if (value) return value;
    console.log(`Please enter a value for ${name}.`);
  }
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePrompt) => rl.question(question, (answer) => {
    rl.close();
    resolvePrompt(answer.trim());
  }));
}

async function promptSecret(question: string): Promise<string> {
  process.stdout.write(question);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();

  return new Promise((resolvePrompt, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
    };
    const onKey = (text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) {
        cleanup();
        process.stdout.write("\n");
        reject(new Error("Cancelled"));
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        process.stdout.write("\n");
        resolvePrompt(value.trim());
      } else if (key.name === "backspace") {
        value = value.slice(0, -1);
      } else if (!key.ctrl && text && !/^\u001b/.test(text)) {
        value += text;
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

function deployNeedsInput(options: Map<string, string>): boolean {
  if (["--server", "--name"].some((name) => !options.get(name))) return true;
  if (options.get("--channel") === "telegram") {
    return !options.get("--telegram-bot-token") && !process.env.PI_SHIP_TELEGRAM_TOKEN;
  }
  if (options.get("--channel") === "slack") {
    return (!options.get("--slack-bot-token") && !process.env.PI_SHIP_SLACK_BOT_TOKEN)
      || (!options.get("--slack-app-token") && !process.env.PI_SHIP_SLACK_APP_TOKEN);
  }
  return false;
}

function certificateOption(options: Map<string, string>): string | undefined {
  const certificate = options.get("--certificate");
  return certificate ? resolveIdentityFile(certificate) : undefined;
}

function resolveIdentityFile(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

function sshArgs(connection: ServerConnection, ...args: string[]): string[] {
  const command = args.at(-1);
  if (command === undefined) throw new Error("SSH command is required");
  return [
    ...(connection.certificate ? ["-i", connection.certificate] : []),
    ...args.slice(0, -1),
    connection.target,
    command,
  ];
}

function withRemoteCleanup(remoteDir: string, command: string): string {
  const directory = shellQuote(remoteDir);
  return `cleanup() { rm -rf -- ${directory}; }; trap cleanup EXIT HUP INT TERM; ${command}`;
}

function scpArgs(connection: ServerConnection, ...args: string[]): string[] {
  return [...(connection.certificate ? ["-i", connection.certificate] : []), ...args];
}

