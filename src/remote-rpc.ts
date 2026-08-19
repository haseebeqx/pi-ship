import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ConnectionOptions } from "./api.js";
import { resolveServer, type ServerConnection } from "./inventory.js";
import { shellQuote } from "./process.js";
import { PiRpc } from "./rpc.js";

export interface ConnectRpcOptions extends ConnectionOptions {
  /** Stable key used to select an isolated persistent session on the server. */
  sessionKey: string;
  /** Called if SSH or the remote Pi process fails after startup. */
  onFatal?: (error: Error) => void;
}

/** Connect to Pi's JSONL RPC mode on a deployed server over SSH. */
export async function connectRpc(options: ConnectRpcOptions): Promise<PiRpc> {
  if (!options.sessionKey) throw new Error("sessionKey is required");

  const connection = await resolveServer(options.server, resolveCertificate(options.certificate));
  const pi = new RemotePiRpc(connection, options.sessionKey, options.onFatal);
  try {
    await pi.start();
    return pi;
  } catch (error) {
    await pi.close().catch(() => undefined);
    throw error;
  }
}

class RemotePiRpc extends PiRpc {
  constructor(
    private readonly connection: ServerConnection,
    private readonly sessionKey: string,
    onFatal?: (error: Error) => void,
  ) {
    // Local process paths are unused because spawnProcess is overridden.
    super({ cwd: "/", agentDir: "/", onFatal });
  }

  protected override spawnProcess(): ChildProcessWithoutNullStreams {
    const digest = createHash("sha256").update(this.sessionKey).digest("hex");
    const sessionDir = `/var/lib/pi-ship/agent/rpc-sessions/${digest}`;
    const remotePi = [
      "mkdir -p", shellQuote(sessionDir), "&& exec",
      "/opt/pi-ship/app/bin/pi-ship-pi",
      "--mode rpc --continue --session-dir", shellQuote(sessionDir), "--approve",
    ].join(" ");
    const remoteCommand = [
      "sudo -n -u pi-ship env",
      "HOME=/var/lib/pi-ship",
      "PATH=/opt/pi-ship/node/bin:/usr/local/bin:/usr/bin:/bin",
      "PI_SHIP_CONFIG=/etc/pi-ship/config.json",
      "/bin/sh -c", shellQuote(remotePi),
    ].join(" ");
    const args = [
      ...(this.connection.certificate ? ["-i", this.connection.certificate] : []),
      this.connection.target,
      remoteCommand,
    ];
    return spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
  }
}

function resolveCertificate(certificate: string | undefined): string | undefined {
  if (!certificate) return undefined;
  if (certificate === "~") return homedir();
  if (certificate.startsWith("~/")) return join(homedir(), certificate.slice(2));
  return resolve(certificate);
}
