import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

export type PiRpcEvent = Record<string, unknown>;

export interface PiRpcOptions {
  cwd: string;
  agentDir: string;
  /** Called if the child process fails after startup. */
  onFatal?: (error: Error) => void;
  /** Continue the most recent persistent session. Defaults to true. */
  continueSession?: boolean;
  /** Override the session directory passed to Pi. */
  sessionDir?: string;
}

/** A typed Node.js client for Pi's JSONL RPC subprocess mode. */
export class PiRpc {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopping = false;
  private nextId = 0;
  private readonly listeners = new Set<(event: PiRpcEvent) => void>();
  private readonly pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private settled: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private exitError: Error | undefined;
  private readonly options: PiRpcOptions;

  constructor(options: PiRpcOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("Pi RPC process has already been started");
    const piModule = import.meta.resolve("@earendil-works/pi-coding-agent");
    const cliPath = fileURLToPath(new URL("cli.js", piModule));
    const sessionDir = this.options.sessionDir ?? join(homedir(), ".pi", "agent", "sessions");
    const sessionArgs = this.options.continueSession === false
      ? ["--no-session"]
      : ["--continue", "--session-dir", sessionDir];
    const child = spawn(process.execPath, [cliPath, "--mode", "rpc", ...sessionArgs, "--approve"], {
      cwd: this.options.cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: this.options.agentDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[pi] ${chunk.toString()}`));
    child.once("error", (error) => {
      const failure = new Error(`Could not start Pi RPC process: ${error.message}`);
      this.fail(failure);
      if (!this.stopping) this.options.onFatal?.(failure);
    });
    child.once("exit", (code, signal) => {
      const failure = new Error(`Pi RPC process exited (${signal ?? code ?? "unknown"})`);
      this.fail(failure);
      if (!this.stopping) this.options.onFatal?.(failure);
    });
    this.readJsonLines(child);

    await this.send({ type: "get_state" });
  }

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(message: string): Promise<void> {
    if (this.settled) throw new Error("Pi already has an active prompt");
    const completion = new Promise<void>((resolve, reject) => { this.settled = { resolve, reject }; });
    try {
      await this.send({ type: "prompt", message });
    } catch (error) {
      this.settled = undefined;
      throw error;
    }
    await completion;
  }

  send(command: PiRpcEvent): Promise<void> {
    if (this.exitError) return Promise.reject(this.exitError);
    if (!this.child) return Promise.reject(new Error("Pi RPC process is not running"));

    const id = `ship-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 5_000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
  }

  private readJsonLines(child: ChildProcessWithoutNullStreams): void {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line) this.handleLine(line);
      }
    });
    child.stdout.once("end", () => {
      buffer += decoder.end();
      if (buffer) this.handleLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    });
  }

  private handleLine(line: string): void {
    let event: PiRpcEvent;
    try {
      event = JSON.parse(line) as PiRpcEvent;
    } catch (error) {
      this.fail(new Error(`Invalid JSON from Pi RPC process: ${(error as Error).message}`));
      this.child?.kill("SIGTERM");
      return;
    }

    if (event.type === "response" && typeof event.id === "string") {
      const request = this.pending.get(event.id);
      if (request) {
        this.pending.delete(event.id);
        if (event.success === true) request.resolve();
        else request.reject(new Error(typeof event.error === "string" ? event.error : "Pi RPC command failed"));
      }
    }

    for (const listener of this.listeners) listener(event);
    if (event.type === "agent_settled" && this.settled) {
      const settled = this.settled;
      this.settled = undefined;
      settled.resolve();
    }
  }

  private fail(error: Error): void {
    if (this.exitError) return;
    this.exitError = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    if (this.settled) {
      this.settled.reject(error);
      this.settled = undefined;
    }
  }
}
