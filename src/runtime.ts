#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { SlackProvider } from "./channels/slack.js";
import { TelegramProvider } from "./channels/telegram.js";
import { bufferedResponse, type CommunicationProvider, type IncomingMessage, type OutboundResponse } from "./channels/types.js";
import { exposeModelCredential, loadJson, type ShipConfig, type ShipSecrets } from "./config.js";

const configPath = process.env.PI_SHIP_CONFIG ?? "/etc/pi-ship/config.json";
const secretsPath = process.env.PI_SHIP_SECRETS ?? "/etc/pi-ship/secrets.json";
const config = await loadJson<ShipConfig>(configPath);
const secrets = await loadJson<ShipSecrets>(secretsPath);
exposeModelCredential(secrets);

await mkdir(config.workspace, { recursive: true });
await mkdir(config.agentDir, { recursive: true });

let pi: PiRpc;

const providers: CommunicationProvider[] = [];
if (config.telegram && secrets.telegram) {
  providers.push(new TelegramProvider({
    token: secrets.telegram.botToken,
    pairingCodeHash: config.telegram.pairingCodeHash,
    statePath: config.telegram.statePath,
  }));
}
if (config.slack && secrets.slack) {
  if (!config.slack.pairingCodeHash || !config.slack.statePath) {
    throw new Error("Slack pairing is not configured; redeploy to avoid granting workspace-wide agent access");
  }
  providers.push(new SlackProvider({
    botToken: secrets.slack.botToken,
    appToken: secrets.slack.appToken,
    pairingCodeHash: config.slack.pairingCodeHash,
    statePath: config.slack.statePath,
  }));
}
if (providers.length === 0) throw new Error("No communication provider is configured");
const providerByName = new Map(providers.map((provider) => [provider.name, provider]));

const shutdown = new AbortController();
let queue = Promise.resolve();
const receive = (message: IncomingMessage): Promise<void> => {
  // A persistent Pi session is stateful, so prompts are deliberately serialized.
  const work = queue.then(() => respond(message));
  queue = work.catch((error) => console.error(`[runtime] ${(error as Error).stack ?? error}`));
  return work;
};

async function respond(message: IncomingMessage): Promise<void> {
  const provider = providerByName.get(message.provider);
  if (!provider) throw new Error(`Unknown communication provider: ${message.provider}`);

  let response: OutboundResponse;
  try {
    response = provider.openResponse
      ? await provider.openResponse(message, shutdown.signal)
      : bufferedResponse(provider, message, shutdown.signal);
  } catch (error) {
    console.error(`[runtime] could not open response: ${(error as Error).stack ?? error}`);
    await provider.send(message.conversationId, "Pi could not start a response. Try again shortly.", shutdown.signal);
    return;
  }

  let finalAssistantText = "";
  let streamedText = "";
  let streamError: unknown;
  const writes = new Set<Promise<void>>();
  const append = (delta: string) => {
    streamedText += delta;
    // Invoke immediately so updating providers can coalesce fast token deltas.
    const write = response.append(delta).catch((error) => { streamError ??= error; });
    writes.add(write);
    void write.finally(() => writes.delete(write));
  };
  const unsubscribe = pi.onEvent((event) => {
    const update = objectValue(event.assistantMessageEvent);
    if (event.type === "message_update" && update?.type === "text_delta" && typeof update.delta === "string") {
      append(update.delta);
    } else {
      const completed = objectValue(event.message);
      if (event.type === "message_end" && completed?.role === "assistant") {
        finalAssistantText = assistantText(completed.content);
      }
    }
  });

  try {
    await pi.prompt(message.text);
    await Promise.all(writes);
    if (streamError) throw streamError;
    const fallback = finalAssistantText || streamedText.trim() || "Pi completed the request without a text response.";
    await response.complete(fallback);
  } catch (error) {
    console.error(`[runtime] prompt failed: ${(error as Error).stack ?? error}`);
    await Promise.all(writes);
    await response.fail("Pi could not complete that request. Try again shortly.");
  } finally {
    unsubscribe();
  }
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      typeof block === "object" && block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text)
    .join("\n")
    .trim();
}

async function stop(signal: NodeJS.Signals): Promise<void> {
  console.log(`[runtime] received ${signal}; shutting down`);
  shutdown.abort();
  await queue;
  await pi.stop();
}

type RpcObject = Record<string, unknown>;

function objectValue(value: unknown): RpcObject | undefined {
  return typeof value === "object" && value !== null ? value as RpcObject : undefined;
}

class PiRpc {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 0;
  private readonly listeners = new Set<(event: RpcObject) => void>();
  private readonly pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private settled: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private exitError: Error | undefined;

  constructor(
    private readonly cwd: string,
    private readonly agentDir: string,
    private readonly provider: string,
  ) {}

  async start(): Promise<void> {
    // Resolve the dependency's bin entry without importing Pi into this process.
    const piModule = import.meta.resolve("@earendil-works/pi-coding-agent");
    const cliPath = fileURLToPath(new URL("cli.js", piModule));
    const child = spawn(process.execPath, [
      cliPath,
      "--mode", "rpc",
      "--continue",
      // Match SessionManager.continueRecent() from the former in-process runtime.
      "--session-dir", join(homedir(), ".pi", "agent", "sessions"),
      "--provider", this.provider,
      "--approve",
    ], {
      cwd: this.cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: this.agentDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[pi] ${chunk.toString()}`));
    child.once("error", (error) => this.fail(new Error(`Could not start Pi RPC process: ${error.message}`)));
    child.once("exit", (code, signal) => {
      this.fail(new Error(`Pi RPC process exited (${signal ?? code ?? "unknown"})`));
    });
    this.readJsonLines(child);

    // A response confirms that startup and model/session initialization succeeded.
    await this.send({ type: "get_state" });
  }

  onEvent(listener: (event: RpcObject) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(message: string): Promise<void> {
    if (this.settled) throw new Error("Pi already has an active prompt");
    const completion = new Promise<void>((resolve, reject) => { this.settled = { resolve, reject }; });
    try {
      await this.send({ type: "prompt", message });
    } catch (error) {
      // The prompt was not accepted, so no agent_settled event will arrive.
      this.settled = undefined;
      throw error;
    }
    await completion;
  }

  send(command: RpcObject): Promise<void> {
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
    let event: RpcObject;
    try {
      event = JSON.parse(line) as RpcObject;
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

pi = new PiRpc(config.workspace, config.agentDir, secrets.model.provider);
await pi.start();

process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));

console.log(`[runtime] ${config.name} is online; ${providers.map((provider) => provider.name).join(", ")} started`);
await Promise.all(providers.map((provider) => provider.start(receive, shutdown.signal)));
