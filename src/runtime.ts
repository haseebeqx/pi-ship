#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { SlackProvider } from "./channels/slack.js";
import { TelegramProvider } from "./channels/telegram.js";
import { bufferedResponse, type CommunicationProvider, type IncomingMessage, type OutboundResponse } from "./channels/types.js";
import { loadJson, type ShipConfig, type ShipSecrets } from "./config.js";
import type { PiRpcEvent } from "./rpc.js";
import { ConversationSessions, type ConversationRpc } from "./sessions.js";

const configPath = process.env.PI_SHIP_CONFIG ?? "/etc/pi-ship/config.json";
const secretsPath = process.env.PI_SHIP_SECRETS ?? "/etc/pi-ship/secrets.json";
const config = await loadJson<ShipConfig>(configPath);
const secrets = await loadJson<ShipSecrets>(secretsPath);

await mkdir(config.workspace, { recursive: true });
await mkdir(config.agentDir, { recursive: true });

const sessions = new ConversationSessions({
  cwd: config.workspace,
  agentDir: config.agentDir,
  onFatal: (key, error) => {
    console.error(`[runtime] Pi session ${key} exited: ${error.stack ?? error.message}`);
  },
});

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
const receive = (message: IncomingMessage): Promise<void> => {
  const work = sessions.run(message, (rpc) => respond(message, rpc));
  void work.catch((error) => console.error(`[runtime] ${(error as Error).stack ?? error}`));
  return work;
};

async function respond(message: IncomingMessage, pi: ConversationRpc): Promise<void> {
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
  await sessions.stop();
}

function objectValue(value: unknown): PiRpcEvent | undefined {
  return typeof value === "object" && value !== null ? value as PiRpcEvent : undefined;
}

process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));

let readyCount = 0;
let resolveReady!: () => void;
const allReady = new Promise<void>((resolve) => { resolveReady = resolve; });
const providerRun = Promise.all(providers.map(async (provider) => {
  await provider.start(receive, shutdown.signal, () => {
    readyCount += 1;
    if (readyCount === providers.length) resolveReady();
  });
  if (!shutdown.signal.aborted) throw new Error(`${provider.name} transport stopped unexpectedly`);
}));

await Promise.race([allReady, providerRun]);
await notifyReady(`${config.name} is online; ${providers.map((provider) => provider.name).join(", ")} started`);
console.log(`[runtime] ${config.name} is online; ${providers.map((provider) => provider.name).join(", ")} started`);
await providerRun;

async function notifyReady(status: string): Promise<void> {
  if (!process.env.NOTIFY_SOCKET) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("systemd-notify", ["--ready", `--status=${status}`], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`systemd-notify exited with status ${code ?? "unknown"}`));
    });
  });
}
