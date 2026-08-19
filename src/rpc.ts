import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";

export type PiRpcEvent = Record<string, unknown>;
export type PiRpcCommand = RpcCommand;
export type PiRpcCommandOf<T extends RpcCommand["type"]> = Extract<RpcCommand, { type: T }>;
export type PiRpcResponse<C extends RpcCommand = RpcCommand> = Extract<
  RpcResponse,
  { command: C["type"]; success: true }
>;
export type PiRpcData<C extends RpcCommand> = PiRpcResponse<C> extends infer R
  ? R extends { data: infer D } ? D : void
  : never;
export type PiRpcImage = NonNullable<PiRpcCommandOf<"prompt">["images"]>[number];

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
  private readonly pending = new Map<string, {
    resolve: (response: RpcResponse) => void;
    reject: (error: Error) => void;
  }>();
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
    const child = this.spawnProcess(cliPath, sessionArgs);
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

  /** Send a prompt and wait until Pi has fully settled. */
  async prompt(message: string, images?: PiRpcImage[]): Promise<void> {
    if (this.settled) throw new Error("Pi already has an active prompt");
    const completion = new Promise<void>((resolve, reject) => { this.settled = { resolve, reject }; });
    try {
      await this.send({ type: "prompt", message, images });
    } catch (error) {
      this.settled = undefined;
      throw error;
    }
    await completion;
  }

  steer(message: string, images?: PiRpcImage[]): Promise<void> {
    return this.sendVoid({ type: "steer", message, images });
  }

  followUp(message: string, images?: PiRpcImage[]): Promise<void> {
    return this.sendVoid({ type: "follow_up", message, images });
  }

  abort(): Promise<void> {
    return this.sendVoid({ type: "abort" });
  }

  newSession(parentSession?: string): Promise<PiRpcData<PiRpcCommandOf<"new_session">>> {
    return this.sendData({ type: "new_session", parentSession });
  }

  getState(): Promise<PiRpcData<PiRpcCommandOf<"get_state">>> {
    return this.sendData({ type: "get_state" });
  }

  setModel(provider: string, modelId: string): Promise<PiRpcData<PiRpcCommandOf<"set_model">>> {
    return this.sendData({ type: "set_model", provider, modelId });
  }

  cycleModel(): Promise<PiRpcData<PiRpcCommandOf<"cycle_model">>> {
    return this.sendData({ type: "cycle_model" });
  }

  async getAvailableModels(): Promise<PiRpcData<PiRpcCommandOf<"get_available_models">>["models"]> {
    return (await this.sendData({ type: "get_available_models" })).models;
  }

  setThinkingLevel(level: PiRpcCommandOf<"set_thinking_level">["level"]): Promise<void> {
    return this.sendVoid({ type: "set_thinking_level", level });
  }

  cycleThinkingLevel(): Promise<PiRpcData<PiRpcCommandOf<"cycle_thinking_level">>> {
    return this.sendData({ type: "cycle_thinking_level" });
  }

  async getAvailableThinkingLevels(): Promise<PiRpcData<PiRpcCommandOf<"get_available_thinking_levels">>["levels"]> {
    return (await this.sendData({ type: "get_available_thinking_levels" })).levels;
  }

  setSteeringMode(mode: PiRpcCommandOf<"set_steering_mode">["mode"]): Promise<void> {
    return this.sendVoid({ type: "set_steering_mode", mode });
  }

  setFollowUpMode(mode: PiRpcCommandOf<"set_follow_up_mode">["mode"]): Promise<void> {
    return this.sendVoid({ type: "set_follow_up_mode", mode });
  }

  compact(customInstructions?: string): Promise<PiRpcData<PiRpcCommandOf<"compact">>> {
    return this.sendData({ type: "compact", customInstructions });
  }

  setAutoCompaction(enabled: boolean): Promise<void> {
    return this.sendVoid({ type: "set_auto_compaction", enabled });
  }

  setAutoRetry(enabled: boolean): Promise<void> {
    return this.sendVoid({ type: "set_auto_retry", enabled });
  }

  abortRetry(): Promise<void> {
    return this.sendVoid({ type: "abort_retry" });
  }

  bash(command: string, excludeFromContext?: boolean): Promise<PiRpcData<PiRpcCommandOf<"bash">>> {
    return this.sendData({ type: "bash", command, excludeFromContext });
  }

  abortBash(): Promise<void> {
    return this.sendVoid({ type: "abort_bash" });
  }

  getSessionStats(): Promise<PiRpcData<PiRpcCommandOf<"get_session_stats">>> {
    return this.sendData({ type: "get_session_stats" });
  }

  exportHtml(outputPath?: string): Promise<PiRpcData<PiRpcCommandOf<"export_html">>> {
    return this.sendData({ type: "export_html", outputPath });
  }

  switchSession(sessionPath: string): Promise<PiRpcData<PiRpcCommandOf<"switch_session">>> {
    return this.sendData({ type: "switch_session", sessionPath });
  }

  fork(entryId: string): Promise<PiRpcData<PiRpcCommandOf<"fork">>> {
    return this.sendData({ type: "fork", entryId });
  }

  clone(): Promise<PiRpcData<PiRpcCommandOf<"clone">>> {
    return this.sendData({ type: "clone" });
  }

  async getForkMessages(): Promise<PiRpcData<PiRpcCommandOf<"get_fork_messages">>["messages"]> {
    return (await this.sendData({ type: "get_fork_messages" })).messages;
  }

  getEntries(since?: string): Promise<PiRpcData<PiRpcCommandOf<"get_entries">>> {
    return this.sendData({ type: "get_entries", since });
  }

  getTree(): Promise<PiRpcData<PiRpcCommandOf<"get_tree">>> {
    return this.sendData({ type: "get_tree" });
  }

  async getLastAssistantText(): Promise<string | null> {
    return (await this.sendData({ type: "get_last_assistant_text" })).text;
  }

  setSessionName(name: string): Promise<void> {
    return this.sendVoid({ type: "set_session_name", name });
  }

  async getMessages(): Promise<PiRpcData<PiRpcCommandOf<"get_messages">>["messages"]> {
    return (await this.sendData({ type: "get_messages" })).messages;
  }

  async getCommands(): Promise<PiRpcData<PiRpcCommandOf<"get_commands">>["commands"]> {
    return (await this.sendData({ type: "get_commands" })).commands;
  }

  /** Send any supported RPC command and return its successful correlated response. */
  send<C extends RpcCommand>(command: C): Promise<PiRpcResponse<C>> {
    if (this.exitError) return Promise.reject(this.exitError);
    if (!this.child) return Promise.reject(new Error("Pi RPC process is not running"));

    const id = `ship-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (response) => resolve(response as PiRpcResponse<C>),
        reject,
      });
      this.child!.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private async sendData<C extends RpcCommand>(command: C): Promise<PiRpcData<C>> {
    const response = await this.send(command);
    return ("data" in response ? response.data : undefined) as PiRpcData<C>;
  }

  private async sendVoid<C extends RpcCommand>(command: C): Promise<void> {
    await this.send(command);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 5_000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
  }

  /** Close the RPC transport. Alias for stop(). */
  close(): Promise<void> {
    return this.stop();
  }

  /** Create the process carrying JSONL. Remote transports override this. */
  protected spawnProcess(cliPath: string, sessionArgs: string[]): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, [cliPath, "--mode", "rpc", ...sessionArgs, "--approve"], {
      cwd: this.options.cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: this.options.agentDir },
      stdio: ["pipe", "pipe", "pipe"],
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
        if (event.success === true) request.resolve(event as RpcResponse);
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
