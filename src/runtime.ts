#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
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

const sessionManager = SessionManager.continueRecent(config.workspace);
const { session } = await createAgentSession({
  cwd: config.workspace,
  agentDir: config.agentDir,
  sessionManager,
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
  providers.push(new SlackProvider({
    botToken: secrets.slack.botToken,
    appToken: secrets.slack.appToken,
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
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      append(event.assistantMessageEvent.delta);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      finalAssistantText = assistantText(event.message.content);
    }
  });

  try {
    await session.prompt(message.text, { source: "rpc" });
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
  session.dispose();
}

process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));

console.log(`[runtime] ${config.name} is online; ${providers.map((provider) => provider.name).join(", ")} started`);
await Promise.all(providers.map((provider) => provider.start(receive, shutdown.signal)));
