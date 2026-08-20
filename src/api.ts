import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { InteractiveSessionMode } from "./config.js";
import type { RuntimeProfile, RuntimeSecrets } from "./runtime-profile.js";
import { validateRuntimeProfile, validateRuntimeSecrets } from "./runtime-profile.js";
import {
  configureChannelCommand,
  configureServerCommand,
  connectCommand,
  deployCommand,
  logsCommand,
  statusCommand,
  updateCommand,
  updatePiCommand,
} from "./commands.js";

export interface ConnectionOptions {
  /** A saved Pi Ship server name or SSH target. Uses PI_SHIP_SERVER or the saved default when omitted. */
  server?: string;
  /** SSH identity file. Paths beginning with ~/ are supported. */
  certificate?: string;
}

export type ChannelOptions =
  | { channel?: "none" }
  | { channel: "telegram"; telegramBotToken: string }
  | { channel: "slack"; slackBotToken: string; slackAppToken: string };

export type DeployOptions = ConnectionOptions & ChannelOptions & {
  /** Name under which the connection is saved locally. */
  name: string;
  /** Make this server the default. The first saved server becomes the default automatically. */
  default?: boolean;
  /** Default session persistence for argument-free interactive connections. */
  sessionMode?: InteractiveSessionMode;
  /** Generic process, Pi, filesystem, and resource policy. */
  runtime?: RuntimeProfile;
  /** Secret files installed outside the workspace. Never included in RuntimeProfile. */
  runtimeSecrets?: RuntimeSecrets;
};

export interface ConnectOptions extends ConnectionOptions {
  /** Arguments forwarded to the remote Pi process. */
  piArgs?: readonly string[];
}

export type ConfigureChannelOptions = ConnectionOptions & Exclude<ChannelOptions, { channel?: "none" }> | (ConnectionOptions & { channel: "none" });

export interface ConfigureServerOptions extends ConnectionOptions {
  /** Default session persistence for argument-free interactive connections. */
  sessionMode: InteractiveSessionMode;
}

export interface UpdatePiOptions extends ConnectionOptions {
  /** Pi semver to install. The latest published version is used when omitted. */
  version?: string;
}

/** Deploy Pi Ship to an SSH-accessible server. */
export async function deploy(options: DeployOptions): Promise<void> {
  validateRuntimeProfile(options.runtime);
  validateRuntimeSecrets(options.runtimeSecrets);
  const args = connectionArgs(options);
  args.push("--name", options.name, "--channel", options.channel ?? "none");
  if (options.default) args.push("--default");
  if (options.sessionMode) args.push("--session-mode", options.sessionMode);
  appendChannelArgs(args, options);
  if (!options.runtime && !options.runtimeSecrets) return deployCommand(args);

  const temporary = await mkdtemp(join(tmpdir(), "pi-ship-profile-"));
  try {
    if (options.runtime) {
      const path = join(temporary, "runtime.json");
      await writeFile(path, `${JSON.stringify(options.runtime)}\n`, { mode: 0o600 });
      args.push("--runtime-config", path);
    }
    if (options.runtimeSecrets) {
      const path = join(temporary, "runtime-secrets.json");
      await writeFile(path, `${JSON.stringify(options.runtimeSecrets)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
      args.push("--runtime-secrets", path);
    }
    await deployCommand(args);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Open an interactive or argument-driven Pi session on a deployed server. */
export function connect(options: ConnectOptions): Promise<void> {
  const args = connectionArgs(options);
  if (options.piArgs?.length) args.push("--", ...options.piArgs);
  return connectCommand(args);
}

/** Add, replace, or disable a deployed server's messaging channel. */
export function configureChannel(options: ConfigureChannelOptions): Promise<void> {
  const args = connectionArgs(options);
  args.push("--channel", options.channel);
  appendChannelArgs(args, options);
  return configureChannelCommand(args);
}

/** Change server-wide defaults without redeploying. */
export function configureServer(options: ConfigureServerOptions): Promise<void> {
  const args = connectionArgs(options);
  args.push("--session-mode", options.sessionMode);
  return configureServerCommand(args);
}

/** Update Pi Ship itself on a deployed server. */
export function update(options: ConnectionOptions): Promise<void> {
  return updateCommand(connectionArgs(options));
}

/** Update the Pi coding agent on a deployed server. */
export function updatePi(options: UpdatePiOptions): Promise<void> {
  const args = connectionArgs(options);
  if (options.version) args.push("--version", options.version);
  return updatePiCommand(args);
}

/** Print deployment status to stdout. */
export function status(options: ConnectionOptions): Promise<void> {
  return statusCommand(connectionArgs(options));
}

/** Follow the persistent runtime's systemd logs. */
export function logs(options: ConnectionOptions): Promise<void> {
  return logsCommand(connectionArgs(options));
}

function connectionArgs(options: ConnectionOptions): string[] {
  const args: string[] = [];
  if (options.server) args.push("--server", options.server);
  if (options.certificate) args.push("--certificate", options.certificate);
  return args;
}

function appendChannelArgs(args: string[], options: ChannelOptions): void {
  if (options.channel === "telegram") {
    args.push("--telegram-bot-token", options.telegramBotToken);
  } else if (options.channel === "slack") {
    args.push("--slack-bot-token", options.slackBotToken, "--slack-app-token", options.slackAppToken);
  }
}
