#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SlackProvider } from "./channels/slack.js";
import { TelegramProvider } from "./channels/telegram.js";
import { bufferedResponse, type CommunicationProvider, type IncomingMessage, type OutboundResponse } from "./channels/types.js";
import { loadJson, type ShipConfig, type ShipSecrets } from "./config.js";
import { DeliveryTracker } from "./delivery.js";
import type { PiRpcEvent } from "./rpc.js";
import { SessionManager } from "./session-manager.js";
import { conversationKey, type ConversationIdentity, type ConversationRpc } from "./sessions.js";

const configPath = process.env.PI_SHIP_CONFIG ?? "/etc/pi-ship/config.json";
const secretsPath = process.env.PI_SHIP_SECRETS ?? "/etc/pi-ship/secrets.json";
const config = await loadJson<ShipConfig>(configPath);
const secrets = await loadJson<ShipSecrets>(secretsPath);

await mkdir(config.workspace, { recursive: true });
await mkdir(config.agentDir, { recursive: true });

const sessions = new SessionManager<ConversationIdentity, ConversationRpc>({
  cwd: config.workspace,
  agentDir: config.agentDir,
  key: conversationKey,
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
const deliveries = new DeliveryTracker(join(config.agentDir, "ship-deliveries"));

const shutdown = new AbortController();
const receive = async (message: IncomingMessage): Promise<void> => {
  const provider = providerByName.get(message.provider);
  if (message.text.trim().match(/^\/(?:stop|cancel)(?:\s|$)/i)) {
    const aborted = await sessions.abort(message);
    await provider?.send(message.conversationId, aborted ? "Stopped the active request." : "There is no active request to stop.", shutdown.signal);
    return;
  }
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

  const deliveryId = await deliveries.begin(message.provider, message.conversationId);
  const commandResult = await handleCommand(message.text, pi).catch((error) => `Command failed: ${(error as Error).message}`);
  if (commandResult !== undefined) {
    try {
      await response.complete(commandResult);
      await deliveries.delivered(deliveryId, commandResult);
    } catch (error) {
      await deliveries.update(deliveryId, { text: commandResult, lastError: (error as Error).message });
      throw error;
    }
    return;
  }

  let finalAssistantText = "";
  let streamedText = "";
  let streamError: unknown;
  const writes = new Set<Promise<void>>();
  const activeTools = new Map<string, string>();
  const track = (work: Promise<void>) => {
    const safe = work.catch((error) => { streamError ??= error; });
    writes.add(safe);
    void safe.finally(() => writes.delete(safe));
  };
  const append = (delta: string) => {
    streamedText += delta;
    void deliveries.update(deliveryId, { text: streamedText });
    // Invoke immediately so updating providers can coalesce fast token deltas.
    track(response.append(delta));
  };
  const updateToolProgress = () => {
    const names = [...activeTools.values()];
    track(response.progress(names.length ? `Using ${names.join(", ")}` : undefined));
  };
  const unsubscribe = pi.onEvent((event) => {
    const update = objectValue(event.assistantMessageEvent);
    if (event.type === "message_update" && update?.type === "text_delta" && typeof update.delta === "string") {
      append(update.delta);
    } else if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
      activeTools.set(event.toolCallId, typeof event.toolName === "string" ? event.toolName : "tool");
      updateToolProgress();
    } else if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
      activeTools.delete(event.toolCallId);
      updateToolProgress();
    } else if (event.type === "compaction_start") {
      track(response.progress("Compacting conversation context"));
    } else if (event.type === "auto_retry_start") {
      track(response.progress(`Retrying request (attempt ${String(event.attempt ?? "")})`));
    } else {
      const completed = objectValue(event.message);
      if (event.type === "message_end" && completed?.role === "assistant") {
        finalAssistantText = assistantText(completed.content);
      }
    }
  });

  try {
    const prepared = await preparePrompt(message);
    await pi.prompt(prepared.text, prepared.images);
    await Promise.all(writes);
    if (streamError) throw streamError;
    const fallback = finalAssistantText || streamedText.trim() || "Pi completed the request without a text response.";
    await response.complete(fallback);
    await deliveries.delivered(deliveryId, fallback);
  } catch (error) {
    console.error(`[runtime] prompt failed: ${(error as Error).stack ?? error}`);
    await Promise.all(writes);
    const failureText = "Pi could not complete that request. Try again shortly.";
    try {
      await response.fail(failureText);
      await deliveries.delivered(deliveryId, failureText);
    } catch (deliveryError) {
      await deliveries.update(deliveryId, { text: streamedText || failureText, lastError: (deliveryError as Error).message });
    }
  } finally {
    unsubscribe();
  }
}

async function preparePrompt(message: IncomingMessage) {
  const lines: string[] = [];
  if (message.replyTo) {
    const author = message.replyTo.senderId ? ` from ${message.replyTo.senderId}` : "";
    const quoted = message.replyTo.text ? `:\n> ${message.replyTo.text.replaceAll("\n", "\n> ")}` : "";
    lines.push(`[Replying to message ${message.replyTo.messageId ?? "unknown"}${author}${quoted}]`);
  }
  if (message.text.trim()) lines.push(message.text.trim());

  const images: NonNullable<Parameters<ConversationRpc["prompt"]>[1]> = [];
  for (const [index, attachment] of (message.attachments ?? []).entries()) {
    if (attachment.kind === "image") {
      images.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
      lines.push(`[Attached image: ${attachment.fileName}]`);
      continue;
    }
    const directory = join(config.workspace, ".pi-ship", "uploads");
    await mkdir(directory, { recursive: true });
    const safeName = attachment.fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || `attachment-${index}`;
    const path = join(directory, `${Date.now()}-${index}-${safeName}`);
    await writeFile(path, Buffer.from(attachment.data, "base64"), { mode: 0o600 });
    lines.push(`[Attached ${attachment.kind}: ${path} (${attachment.mimeType})]`);
  }
  return { text: lines.join("\n\n") || "Please review the attached message.", images };
}

async function handleCommand(text: string, pi: ConversationRpc): Promise<string | undefined> {
  const match = text.trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  const command = match[1]!.toLowerCase();
  const argument = match[2]?.trim();
  if (command === "help") {
    return "Commands: /new, /model [provider/model], /models, /thinking <level>, /session, /commands, /stop";
  }
  if (command === "new") {
    if (!pi.newSession) return "Session switching is unavailable.";
    await pi.newSession();
    return "Started a new session.";
  }
  if (command === "models") {
    if (!pi.getAvailableModels) return "Model discovery is unavailable.";
    const models = await pi.getAvailableModels() as Array<{ provider?: string; id?: string; name?: string }>;
    return models.map((model) => `${model.provider ?? "?"}/${model.id ?? "?"}${model.name ? ` — ${model.name}` : ""}`).join("\n") || "No configured models.";
  }
  if (command === "model") {
    if (!argument) {
      const state = await pi.getState?.() as { model?: { provider?: string; id?: string; name?: string } } | undefined;
      const model = state?.model;
      return model ? `Current model: ${model.provider}/${model.id}${model.name ? ` (${model.name})` : ""}` : "No model selected.";
    }
    const slash = argument.indexOf("/");
    if (slash <= 0 || !pi.setModel) return "Usage: /model provider/model-id";
    await pi.setModel(argument.slice(0, slash), argument.slice(slash + 1));
    return `Model changed to ${argument}.`;
  }
  if (command === "thinking") {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
    if (!argument || !levels.includes(argument as typeof levels[number]) || !pi.setThinkingLevel) return `Usage: /thinking ${levels.join("|")}`;
    await pi.setThinkingLevel(argument as typeof levels[number]);
    return `Thinking level changed to ${argument}.`;
  }
  if (command === "session") {
    const state = await pi.getState?.() as Record<string, unknown> | undefined;
    const stats = await pi.getSessionStats?.() as Record<string, unknown> | undefined;
    return `Session: ${String(state?.sessionName ?? state?.sessionId ?? "active")}\nModel: ${String((state?.model as Record<string, unknown> | undefined)?.id ?? "none")}\nMessages: ${String(stats?.totalMessages ?? state?.messageCount ?? 0)}`;
  }
  if (command === "commands") {
    const commands = await pi.getCommands?.() as Array<{ name?: string; description?: string }> | undefined;
    return commands?.map((item) => `/${item.name}${item.description ? ` — ${item.description}` : ""}`).join("\n") || "No Pi extension, prompt, or skill commands are available.";
  }
  return undefined;
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
await retryPendingDeliveries();
const stopOutbox = startProactiveOutbox();
shutdown.signal.addEventListener("abort", stopOutbox, { once: true });
await notifyReady(`${config.name} is online; ${providers.map((provider) => provider.name).join(", ")} started`);
console.log(`[runtime] ${config.name} is online; ${providers.map((provider) => provider.name).join(", ")} started`);
await providerRun;

async function retryPendingDeliveries(): Promise<void> {
  for (const record of await deliveries.pending()) {
    const provider = providerByName.get(record.provider);
    if (!provider) continue;
    try {
      await deliveries.update(record.id, { attempts: record.attempts + 1 });
      await provider.send(record.conversationId, record.text, shutdown.signal);
      await deliveries.delivered(record.id);
    } catch (error) {
      await deliveries.update(record.id, { lastError: (error as Error).message });
      console.error(`[runtime] retrying delivery ${record.id} failed: ${(error as Error).message}`);
    }
  }
}

/**
 * Files written to <workspace>/.pi-ship/outbox are proactive messages. This
 * gives local jobs and trusted Pi extensions a transport-independent API.
 */
function startProactiveOutbox(): () => void {
  const directory = join(config.workspace, ".pi-ship", "outbox");
  let polling = false;
  const poll = async () => {
    if (polling || shutdown.signal.aborted) return;
    polling = true;
    try {
      await mkdir(directory, { recursive: true });
      for (const name of (await readdir(directory)).filter((item) => item.endsWith(".json"))) {
        const source = join(directory, name);
        const claimed = `${source}.sending`;
        try { await rename(source, claimed); } catch { continue; }
        try {
          const item = JSON.parse(await readFile(claimed, "utf8")) as { provider?: string; conversationId?: string; text?: string };
          const provider = item.provider ? providerByName.get(item.provider) : undefined;
          if (!provider || !item.conversationId || !item.text?.trim()) throw new Error("Outbox message requires provider, conversationId, and text");
          const id = await deliveries.begin(provider.name, item.conversationId, item.text);
          try {
            await provider.send(item.conversationId, item.text, shutdown.signal);
            await deliveries.delivered(id);
            await unlink(claimed);
          } catch (error) {
            // The durable tracker now owns retries; remove the source file so
            // polling cannot create a second delivery record.
            await deliveries.update(id, { lastError: (error as Error).message });
            await unlink(claimed);
          }
        } catch (error) {
          console.error(`[runtime] proactive message ${name} failed: ${(error as Error).message}`);
          await rename(claimed, source).catch(() => undefined);
        }
      }
    } finally {
      polling = false;
    }
  };
  void poll();
  const timer = setInterval(() => void poll(), 2_000);
  return () => clearInterval(timer);
}

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
