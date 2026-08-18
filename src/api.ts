import {
  configureChannelCommand,
  connectCommand,
  deployCommand,
  logsCommand,
  statusCommand,
  updateCommand,
  updatePiCommand,
} from "./commands.js";

export interface ConnectionOptions {
  /** A saved Pi Ship server name or an SSH target such as user@example.com. */
  server: string;
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
};

export interface ConnectOptions extends ConnectionOptions {
  /** Arguments forwarded to the remote Pi process. */
  piArgs?: readonly string[];
}

export type ConfigureChannelOptions = ConnectionOptions & Exclude<ChannelOptions, { channel?: "none" }> | (ConnectionOptions & { channel: "none" });

export interface UpdatePiOptions extends ConnectionOptions {
  /** Pi semver to install. The latest published version is used when omitted. */
  version?: string;
}

/** Deploy Pi Ship to an SSH-accessible server. */
export function deploy(options: DeployOptions): Promise<void> {
  const args = connectionArgs(options);
  args.push("--name", options.name, "--channel", options.channel ?? "none");
  appendChannelArgs(args, options);
  return deployCommand(args);
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
  const args = ["--server", options.server];
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
