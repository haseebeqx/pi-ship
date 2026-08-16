#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { TelegramProvider } from "./channels/telegram.js";
import type { IncomingMessage } from "./channels/types.js";
import { exposeModelCredential, loadJson, type ShipConfig, type ShipSecrets } from "./config.js";

const configPath = process.env.PI_SHIP_CONFIG ?? "/etc/pi-ship/config.json";
const secretsPath = process.env.PI_SHIP_SECRETS ?? "/etc/pi-ship/secrets.json";
const config = await loadJson<ShipConfig>(configPath);
const secrets = await loadJson<ShipSecrets>(secretsPath);
exposeModelCredential(secrets);

await mkdir(config.workspace, { recursive: true });
await mkdir(config.agentDir, { recursive: true });

const sessionManager = SessionManager.continueRecent(config.workspace);
const { session } = await createAgentSession({
  cwd: config.workspace,
  agentDir: config.agentDir,
  sessionManager,
});

const telegram = new TelegramProvider({
  token: secrets.telegram.botToken,
  pairingCodeHash: config.telegram.pairingCodeHash,
  statePath: config.telegram.statePath,
});

const shutdown = new AbortController();
let lastAssistantText = "";
session.subscribe((event) => {
  if (event.type === "message_end" && event.message.role === "assistant") {
    lastAssistantText = assistantText(event.message.content);
  }
});

let queue = Promise.resolve();
const receive = (message: IncomingMessage): Promise<void> => {
  const work = queue.then(() => respond(message));
  queue = work.catch((error) => console.error(`[runtime] ${(error as Error).stack ?? error}`));
  return work;
};

async function respond(message: IncomingMessage): Promise<void> {
  lastAssistantText = "";
  try {
    await session.prompt(message.text, { source: "rpc" });
    await telegram.send(
      message.conversationId,
      lastAssistantText || "Pi completed the request without a text response.",
      shutdown.signal,
    );
  } catch (error) {
    console.error(`[runtime] prompt failed: ${(error as Error).stack ?? error}`);
    await telegram.send(message.conversationId, "Pi could not complete that request. Try again shortly.", shutdown.signal);
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
  session.dispose();
}

process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));

console.log(`[runtime] ${config.name} is online; Telegram long polling started`);
await telegram.start(receive, shutdown.signal);
