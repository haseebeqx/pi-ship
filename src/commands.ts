import { randomBytes } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface, emitKeypressEvents } from "node:readline";
import { hashPairingCode } from "./pairing.js";
import { impliedServer, resolveServer, saveServer } from "./inventory.js";
import type { ServerConnection } from "./inventory.js";
import { run, shellQuote } from "./process.js";
import { compareVersions, validateVersion } from "./version.js";
import { validateInteractiveSessionMode, type ShipConfig, type ShipSecrets } from "./config.js";
import { validateRuntimeProfile, validateRuntimeSecrets, type RuntimeProfile, type RuntimeSecrets } from "./runtime-profile.js";

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command = "help", ...args] = argv;
  if (command === "help") {
    printHelp(args[0]);
    return;
  }
  if (command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (args[0] === "--help" || args[0] === "-h") {
    printHelp(command);
    return;
  }

  switch (command) {
    case "deploy": await deployCommand(args); break;
    case "pi": await connectCommand(args); break;
    case "channel": await configureChannelCommand(args); break;
    case "config": await configureServerCommand(args); break;
    case "update": await updateCommand(args); break;
    case "update-pi": await updatePiCommand(args); break;
    case "status": await statusCommand(args); break;
    case "logs": await logsCommand(args); break;
    default: throw new Error(`Unknown command: ${command}`);
  }
}

export async function deployCommand(args: string[]): Promise<void> {
  const options = parseOptions(args, [
    "--server", "--certificate", "--name", "--channel", "--default",
    "--telegram-bot-token", "--slack-bot-token", "--slack-app-token",
    "--runtime-config", "--runtime-secrets", "--session-mode",
  ], ["--default"]);
  const interactive = process.stdin.isTTY && process.stdout.isTTY && deployNeedsInput(options);
  const target = await selectedServer(options, "SSH server (user@host): ", false);
  const certificate = options.get("--certificate")
    ?? (interactive ? await prompt("SSH identity file (optional, press Enter to use password/agent): ") : undefined);
  const name = await required(options, "--name", "Name this Pi", { defaultValue: "my-pi" });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(name)) {
    throw new Error("The name must contain only letters, numbers, _ or -, and be at most 32 characters.");
  }

  const requestedChannel = options.get("--channel")
    ?? (interactive ? await promptDeployChannel() : "none");
  const channel = requestedChannel === "none" ? "connect" : requestedChannel;
  if (channel !== "connect" && channel !== "telegram" && channel !== "slack") {
    throw new Error(`Unsupported communication channel: ${requestedChannel}`);
  }
  const connection: ServerConnection = {
    target,
    certificate: certificate ? resolveIdentityFile(certificate) : undefined,
  };

  const pairingCode = channel === "connect" ? undefined : randomBytes(5).toString("hex").toUpperCase();
  const sessionMode = options.get("--session-mode") ?? "ephemeral";
  validateInteractiveSessionMode(sessionMode);
  const config: ShipConfig = {
    name,
    workspace: "/var/lib/pi-ship/workspace",
    agentDir: "/var/lib/pi-ship/agent",
    interactiveSessionMode: sessionMode,
  };
  const secrets: ShipSecrets = {};
  if (options.get("--runtime-config")) {
    config.runtime = JSON.parse(await readFile(resolve(options.get("--runtime-config")!), "utf8")) as RuntimeProfile;
    validateRuntimeProfile(config.runtime);
  }
  if (options.get("--runtime-secrets")) {
    secrets.runtime = JSON.parse(await readFile(resolve(options.get("--runtime-secrets")!), "utf8")) as RuntimeSecrets;
    validateRuntimeSecrets(secrets.runtime);
  }
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
  let madeDefault = false;
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
    madeDefault = await saveServer(name, connection, options.has("--default"));
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
    console.log(`\nPi will run only while you are connected. Start a ${sessionMode === "persistent" ? "saved" : "one-off"} session with:`);
    console.log(madeDefault ? "  pi-ship pi" : `  pi-ship pi --server ${name}`);
  }
  console.log(madeDefault
    ? "\nCheck it later with: pi-ship status"
    : `\nCheck it later with: pi-ship status --server ${name}`);
}

export async function connectCommand(args: string[]): Promise<void> {
  const { shipArgs, piArgs } = splitPiArgs(args);
  const options = parseOptions(shipArgs, ["--server", "--certificate"]);
  const server = await selectedServer(options);
  const connection = await resolveServer(server, certificateOption(options));
  const executable = "sudo -n -u pi-ship env HOME=/var/lib/pi-ship PATH=/opt/pi-ship/node/bin:/usr/local/bin:/usr/bin:/bin PI_SHIP_CONFIG=/etc/pi-ship/config.json /opt/pi-ship/app/bin/pi-ship-pi";
  const remoteCommand = [executable, ...piArgs.map(shellQuote)].join(" ");
  const ttyArgs = process.stdin.isTTY && process.stdout.isTTY ? ["-t"] : [];
  await run("ssh", sshArgs(connection, ...ttyArgs, remoteCommand));
}

export async function configureChannelCommand(args: string[]): Promise<void> {
  const options = parseOptions(args, [
    "--server", "--certificate", "--channel",
    "--telegram-bot-token", "--slack-bot-token", "--slack-app-token",
  ]);
  const server = await selectedServer(options);
  const connection = await resolveServer(server, certificateOption(options));
  const currentText = await run("ssh", sshArgs(connection, "sudo -n cat /etc/pi-ship/config.json"), { capture: true });
  const current = JSON.parse(currentText) as ShipConfig;
  const currentChannel = current.telegram ? "telegram" : current.slack ? "slack" : "none";
  const requested = options.get("--channel") ?? await promptChannel(currentChannel);
  const channel = requested === "connect" ? "none" : requested;
  if (channel !== "none" && channel !== "telegram" && channel !== "slack") {
    throw new Error(`Unsupported communication channel: ${requested}`);
  }

  const pairingCode = channel === "none" ? undefined : randomBytes(5).toString("hex").toUpperCase();
  const config: ShipConfig = {
    name: current.name,
    workspace: current.workspace,
    agentDir: current.agentDir,
    interactiveSessionMode: current.interactiveSessionMode,
    runtime: current.runtime,
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

  const temporary = await mkdtemp(join(tmpdir(), "pi-ship-channel-"));
  try {
    const configFile = join(temporary, "config.json");
    const secretsFile = join(temporary, "secrets.json");
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await writeFile(secretsFile, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
    const remoteDir = `/tmp/pi-ship-${randomBytes(6).toString("hex")}`;
    await run("ssh", sshArgs(connection, `install -d -m 700 ${shellQuote(remoteDir)}`));
    await run("scp", scpArgs(connection, configFile, secretsFile, join(packageRoot(), "scripts", "install.sh"), `${connection.target}:${remoteDir}/`));
    const configure = `${remoteDir}/install.sh configure ${remoteDir}/config.json ${remoteDir}/secrets.json`;
    const elevate = `if [ \"$(id -u)\" = 0 ]; then bash ${configure}; else sudo -n bash ${configure}; fi`;
    await run("ssh", sshArgs(connection, withRemoteCleanup(remoteDir, elevate)));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  if (channel === "none") {
    console.log(`✓ Messaging is disabled on ${server}; Pi now runs on demand.`);
  } else {
    console.log(`✓ ${channel === "telegram" ? "Telegram" : "Slack"} is configured on ${server}.`);
    console.log("\nSend this direct message to the bot:");
    console.log(`  /pair ${pairingCode}`);
  }
}

export async function configureServerCommand(args: string[]): Promise<void> {
  const options = parseOptions(args, ["--server", "--certificate", "--session-mode"]);
  const server = await selectedServer(options);
  const connection = await resolveServer(server, certificateOption(options));
  const currentText = await run("ssh", sshArgs(connection, "sudo -n cat /etc/pi-ship/config.json"), { capture: true });
  const config = JSON.parse(currentText) as ShipConfig;
  const currentMode = config.interactiveSessionMode ?? "ephemeral";
  const sessionMode = await required(options, "--session-mode", "Interactive session mode", { defaultValue: currentMode });
  validateInteractiveSessionMode(sessionMode);
  config.interactiveSessionMode = sessionMode;

  const temporary = await mkdtemp(join(tmpdir(), "pi-ship-config-"));
  try {
    const configFile = join(temporary, "config.json");
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const remoteDir = `/tmp/pi-ship-${randomBytes(6).toString("hex")}`;
    await run("ssh", sshArgs(connection, `install -d -m 700 ${shellQuote(remoteDir)}`));
    await run("scp", scpArgs(connection, configFile, join(packageRoot(), "scripts", "install.sh"), `${connection.target}:${remoteDir}/`));
    const configure = `${remoteDir}/install.sh configure-session-mode ${remoteDir}/config.json`;
    const elevate = `if [ \"$(id -u)\" = 0 ]; then bash ${configure}; else sudo -n bash ${configure}; fi`;
    await run("ssh", sshArgs(connection, withRemoteCleanup(remoteDir, elevate)));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  console.log(`✓ Argument-free interactive sessions on ${server} are now ${sessionMode}.`);
}

export async function updateCommand(args: string[]): Promise<void> {
  const options = parseOptions(args, ["--server", "--certificate"]);
  const name = await selectedServer(options);
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

export async function updatePiCommand(args: string[]): Promise<void> {
  const options = parseOptions(args, ["--server", "--certificate", "--version"]);
  const name = await selectedServer(options);
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

export async function statusCommand(args: string[]): Promise<void> {
  const options = parseOptions(args, ["--server", "--certificate"]);
  const server = await selectedServer(options);
  const connection = await resolveServer(server, certificateOption(options));
  const remoteCommand = "printf 'Runtime version: '; cat /opt/pi-ship/version; printf 'Pi version: '; /opt/pi-ship/node/bin/node -p \"require('/opt/pi-ship/app/lib/node_modules/pi-ship/node_modules/@earendil-works/pi-coding-agent/package.json').version\"; printf 'Interactive sessions: '; sudo -n /opt/pi-ship/node/bin/node -p \"require('/etc/pi-ship/config.json').interactiveSessionMode || 'ephemeral'\" && if sudo -n systemctl is-enabled --quiet pi-ship.service; then printf 'Mode: communication provider (persistent)\\n'; sudo -n systemctl is-active pi-ship.service; sudo -n systemctl --no-pager --full status pi-ship.service | head -n 12; else printf 'Mode: connect (on demand)\\n'; fi";
  const output = await run("ssh", sshArgs(connection, remoteCommand), { capture: true });
  process.stdout.write(output);
}

export async function logsCommand(args: string[]): Promise<void> {
  const options = parseOptions(args, ["--server", "--certificate"]);
  const server = await selectedServer(options);
  const connection = await resolveServer(server, certificateOption(options));
  await run("ssh", sshArgs(connection, "-t", "sudo -n journalctl -u pi-ship.service -n 100 -f"));
}

const commandHelp: Record<string, string> = {
  deploy: `Install Pi Ship on a Linux server over SSH and save the server locally.

Usage:
  pi-ship deploy [options]

Options:
  --server <user@host>              SSH destination (prompted if omitted)
  --name <name>                     Local name for this server (default: my-pi)
  --certificate <path>              SSH identity file
  --default                         Make this the default server
  --channel <telegram|slack|none>   Configure persistent messaging (default: none)
  --session-mode <mode>             Interactive sessions: ephemeral or persistent
  --telegram-bot-token <token>      Telegram bot token
  --slack-bot-token <token>         Slack bot token (xoxb-)
  --slack-app-token <token>         Slack Socket Mode token (xapp-)
  --runtime-config <json-file>      Runtime profile JSON
  --runtime-secrets <json-file>     Runtime secrets JSON

Example:
  pi-ship deploy --server ubuntu@example.com --name production --default`,
  pi: `Open Pi on a deployed server over SSH.

With no Pi arguments, this opens an interactive, on-demand terminal session.
Arguments after Pi Ship options (or after --) are passed to the remote Pi CLI.

Usage:
  pi-ship pi [--server <name-or-user@host>] [--certificate <path>] [-- <pi-args...>]

Examples:
  pi-ship pi
  pi-ship pi --server production
  pi-ship pi --server production -- install npm:@foo/bar`,
  config: `Change server-wide Pi Ship defaults without redeploying.

Usage:
  pi-ship config [--server <name-or-user@host>] [--certificate <path>]
                 --session-mode <ephemeral|persistent>

Options:
  --server <name-or-user@host>              Server to configure
  --certificate <path>                     SSH identity file
  --session-mode <ephemeral|persistent>     Default for argument-free pi sessions`,
  channel: `Add, replace, reconfigure, or remove Telegram or Slack messaging.

Omit --channel in a terminal to choose from an interactive menu. Selecting none
stops the persistent service; Pi remains available through pi-ship pi.

Usage:
  pi-ship channel [options]

Options:
  --server <name-or-user@host>       Server to configure
  --certificate <path>              SSH identity file
  --channel <telegram|slack|none>    Messaging provider or none to disable it
  --telegram-bot-token <token>       Telegram bot token
  --slack-bot-token <token>          Slack bot token (xoxb-)
  --slack-app-token <token>          Slack Socket Mode token (xapp-)`,
  update: `Update Pi Ship on a server when the locally installed package is newer.
Configuration, credentials, workspace data, and Pi are preserved.

Usage:
  pi-ship update [--server <name-or-user@host>] [--certificate <path>]`,
  "update-pi": `Update the Pi coding agent without updating Pi Ship.
The latest npm release is used unless --version is supplied.

Usage:
  pi-ship update-pi [--server <name-or-user@host>] [--certificate <path>]
                    [--version <semver>]`,
  status: `Show the installed Pi Ship and Pi versions, operating mode, and service status.

Usage:
  pi-ship status [--server <name-or-user@host>] [--certificate <path>]`,
  logs: `Follow the persistent messaging service log, starting with its latest 100 entries.
This is useful for diagnosing Telegram, Slack, or startup problems.

Usage:
  pi-ship logs [--server <name-or-user@host>] [--certificate <path>]`,
};

function printHelp(command?: string): void {
  if (command) {
    const help = commandHelp[command];
    if (!help) throw new Error(`Unknown command: ${command}`);
    console.log(`${command} — ${help}`);
    return;
  }

  console.log(`pi-ship — Deploy and manage Pi on a remote server

Usage:
  pi-ship <command> [options]

Commands:
  deploy      Install Pi Ship on a server over SSH
  pi          Open an interactive session or run the remote Pi CLI
  channel     Configure or disable Telegram or Slack messaging
  config      Change server-wide interactive session defaults
  status      Show versions, operating mode, and service health
  logs        Follow logs from the persistent messaging service
  update      Update the Pi Ship runtime on a server
  update-pi   Update the Pi coding agent separately
  help        Show help for a command

Getting started:
  pi-ship deploy
  pi-ship pi

Run pi-ship help <command> (or pi-ship <command> --help) for usage and options.
When --server is omitted, commands use PI_SHIP_SERVER and then the saved default.`);
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

function parseOptions(args: string[], allowed: string[], flags: string[] = []): Map<string, string> {
  const options = new Map<string, string>();
  const seen = new Set<string>();
  for (let index = 0; index < args.length;) {
    const name = args[index];
    if (!name?.startsWith("--")) throw new Error(`Unexpected positional argument: ${name}`);
    if (!allowed.includes(name)) throw new Error(`Unknown option: ${name}`);
    if (seen.has(name)) throw new Error(`Option supplied more than once: ${name}`);
    seen.add(name);

    if (flags.includes(name)) {
      options.set(name, "true");
      index += 1;
      continue;
    }
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

async function selectedServer(
  options: Map<string, string>,
  question = "Server (saved name or user@host): ",
  allowSavedDefault = true,
): Promise<string> {
  const selected = (options.get("--server") ?? process.env.PI_SHIP_SERVER)
    || (allowSavedDefault ? await impliedServer() : undefined);
  if (selected) return selected;
  return required(options, "--server", question);
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

async function promptDeployChannel(): Promise<string> {
  console.log("Messaging provider (optional):");
  console.log("  1) Telegram\n  2) Slack\n  3) None (on demand only, default)");
  while (true) {
    const answer = (await prompt("Choose a provider [3]: ")).toLowerCase();
    const channel = ({ "": "none", "1": "telegram", "2": "slack", "3": "none", telegram: "telegram", slack: "slack", none: "none" } as Record<string, string>)[answer];
    if (channel) return channel;
    console.log("Please choose 1, 2, or 3.");
  }
}

async function promptChannel(current: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Missing required option: --channel (cannot prompt without a terminal)");
  }
  console.log(`Current messaging provider: ${current}`);
  console.log("  1) Telegram\n  2) Slack\n  3) None (on demand only)");
  while (true) {
    const answer = (await prompt("Choose a provider [1-3]: ")).toLowerCase();
    const channel = ({ "1": "telegram", "2": "slack", "3": "none", telegram: "telegram", slack: "slack", none: "none" } as Record<string, string>)[answer];
    if (channel) return channel;
    console.log("Please choose 1, 2, or 3.");
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
  if ((!options.get("--server") && !process.env.PI_SHIP_SERVER)
    || ["--name", "--channel"].some((name) => !options.get(name))) return true;
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

