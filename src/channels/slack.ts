import type { CommunicationProvider, IncomingMessage, MessageHandler, OutboundResponse } from "./types.js";
import { UpdatingResponse } from "./updating-response.js";
import { pairingCodeMatches, PairingStore } from "../pairing.js";
import { fetchWithRetry } from "./retry.js";

interface SlackResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  user_id?: string;
  url?: string;
}

interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  url_private_download?: string;
  url_private?: string;
}

interface SlackEvent {
  type?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  files?: SlackFile[];
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
}

interface SlackEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: { event?: SlackEvent };
}

export interface SlackOptions {
  botToken: string;
  appToken: string;
  pairingCodeHash: string;
  statePath: string;
  fetch?: typeof globalThis.fetch;
  webSocket?: typeof WebSocket;
}

/** Slack Socket Mode transport. It needs no public webhook or inbound port. */
export class SlackProvider implements CommunicationProvider {
  readonly name = "slack";
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly WebSocketClass: typeof WebSocket;
  private readonly store: PairingStore;
  private botUserId = "";

  constructor(private readonly options: SlackOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.WebSocketClass = options.webSocket ?? globalThis.WebSocket;
    this.store = new PairingStore(options.statePath);
    if (!this.WebSocketClass) throw new Error("This Node.js runtime does not provide WebSocket support");
  }

  async start(handler: MessageHandler, signal: AbortSignal, onReady?: () => void): Promise<void> {
    await this.store.load();
    const auth = await this.call("auth.test", {}, this.options.botToken, signal);
    this.botUserId = auth.user_id ?? "";
    let ready = false;

    while (!signal.aborted) {
      try {
        const connection = await this.call("apps.connections.open", {}, this.options.appToken, signal);
        if (!connection.url) throw new Error("Slack did not return a Socket Mode URL");
        await this.consume(connection.url, handler, signal, () => {
          if (ready) return;
          ready = true;
          onReady?.();
        });
      } catch (error) {
        if (signal.aborted) return;
        console.error(`[slack] ${(error as Error).message}`);
        await sleep(2_000, signal);
      }
    }
  }

  async send(conversationId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.call("chat.postMessage", { channel: conversationId, text }, this.options.botToken, signal);
  }

  async openResponse(message: IncomingMessage, signal: AbortSignal): Promise<OutboundResponse> {
    const timestamps: string[] = [];
    const published: string[] = [];
    return new UpdatingResponse({
      // chat.update is generally limited to roughly one request per second per channel.
      minUpdateIntervalMs: 1_000,
      publish: async (text) => {
        const parts = splitSlackMessage(adaptMarkdownForSlack(text));
        for (let index = 0; index < parts.length; index += 1) {
          const part = parts[index]!;
          if (!timestamps[index]) {
            const sent = await this.call("chat.postMessage", {
              channel: message.conversationId,
              text: part,
              ...(message.threadId ? { thread_ts: message.threadId } : {}),
            }, this.options.botToken, signal);
            if (!sent.ts) throw new Error("Slack did not return a message timestamp");
            timestamps[index] = sent.ts;
            published[index] = part;
          } else if (published[index] !== part) {
            await this.call("chat.update", {
              channel: message.conversationId,
              ts: timestamps[index],
              text: part,
            }, this.options.botToken, signal);
            published[index] = part;
          }
        }

        // A failure can replace an already-streamed response with shorter text.
        // Remove continuation messages which are no longer part of the snapshot.
        for (let index = timestamps.length - 1; index >= parts.length; index -= 1) {
          await this.call("chat.delete", {
            channel: message.conversationId,
            ts: timestamps[index],
          }, this.options.botToken, signal);
          timestamps.pop();
          published.pop();
        }
      },
    });
  }

  private consume(
    url: string,
    handler: MessageHandler,
    signal: AbortSignal,
    onOpen: () => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketClass(url);
      let opened = false;
      const abort = () => socket.close();
      signal.addEventListener("abort", abort, { once: true });

      socket.addEventListener("open", () => {
        opened = true;
        onOpen();
      });
      socket.addEventListener("message", (raw) => {
        void this.handleEnvelope(String(raw.data), socket, handler).catch((error) => {
          console.error(`[slack] event failed: ${(error as Error).message}`);
        });
      });
      socket.addEventListener("error", () => {
        if (!opened) reject(new Error("Slack Socket Mode connection failed"));
      }, { once: true });
      socket.addEventListener("close", () => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, { once: true });
    });
  }

  private async handleEnvelope(raw: string, socket: WebSocket, handler: MessageHandler): Promise<void> {
    const envelope = JSON.parse(raw) as SlackEnvelope;
    if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    if (envelope.type !== "events_api") return;

    const event = envelope.payload?.event;
    if (!event || event.bot_id || !event.user) return;
    if (event.type === "reaction_added") {
      const channel = event.item?.channel;
      if (!channel || !this.store.has(event.user)) return;
      await handler({
        provider: this.name,
        conversationId: channel,
        senderId: event.user,
        text: `[Reaction :${event.reaction ?? "unknown"}: on message ${event.item?.ts ?? "unknown"}]`,
        threadId: event.item?.ts,
      });
      return;
    }
    if (event.subtype || !event.channel || (event.type !== "message" && event.type !== "app_mention")) return;

    const isDirectMessage = event.channel_type === "im";
    const mentionsBot = event.type === "app_mention" || (event.text ?? "").includes(`<@${this.botUserId}>`);
    if (!isDirectMessage && !mentionsBot) return;
    const text = (event.text ?? "").replaceAll(`<@${this.botUserId}>`, "").trim();
    if (!text && !event.files?.length) return;

    if (!this.store.has(event.user)) {
      // Pairing is intentionally DM-only so the one-time code is never exposed in a channel.
      if (!isDirectMessage) return;
      if (this.store.hasAny()) {
        await this.send(event.channel, "This Pi is already paired with its owner.");
        return;
      }
      const match = text.match(/^\/pair\s+(.+)$/i);
      if (match?.[1] && pairingCodeMatches(match[1], this.options.pairingCodeHash)) {
        await this.store.add(event.user);
        await this.send(event.channel, "Paired. This Pi will now respond only to your Slack account.");
      } else {
        await this.send(event.channel, "This Pi is private. Send /pair followed by the code shown during deployment.");
      }
      return;
    }

    const attachments = await this.downloadAttachments(event.files ?? []);
    await handler({
      provider: this.name,
      conversationId: event.channel,
      senderId: event.user,
      text,
      ...(attachments.length ? { attachments } : {}),
      ...(event.thread_ts ? { replyTo: { messageId: event.thread_ts } } : {}),
      threadId: isDirectMessage ? event.thread_ts : (event.thread_ts ?? event.ts),
    });
  }

  private async downloadAttachments(files: SlackFile[]) {
    return Promise.all(files.map(async (file) => {
      const url = file.url_private_download ?? file.url_private;
      if (!url) throw new Error(`Slack file ${file.id ?? file.name ?? "unknown"} has no download URL`);
      const response = await this.fetchFn(url, {
        headers: { authorization: `Bearer ${this.options.botToken}` },
      });
      if (!response.ok) throw new Error(`Slack file download returned HTTP ${response.status}`);
      const mimeType = file.mimetype ?? response.headers.get("content-type") ?? "application/octet-stream";
      return {
        kind: mimeType.startsWith("image/") ? "image" as const : mimeType.startsWith("audio/") ? "audio" as const : "document" as const,
        fileName: file.name ?? `slack-file-${file.id ?? Date.now()}.${file.filetype ?? "bin"}`,
        mimeType,
        data: Buffer.from(await response.arrayBuffer()).toString("base64"),
      };
    }));
  }

  private async call(
    method: string,
    body: object,
    token: string,
    signal?: AbortSignal,
  ): Promise<SlackResponse> {
    const response = await fetchWithRetry(() => this.fetchFn(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal,
    }), { signal });
    if (!response.ok) throw new Error(`Slack returned HTTP ${response.status}`);
    const payload = await response.json() as SlackResponse;
    if (!payload.ok) throw new Error(payload.error ?? `Slack ${method} failed`);
    return payload;
  }
}

/** Convert common Markdown constructs to Slack mrkdwn without changing code blocks. */
export function adaptMarkdownForSlack(text: string): string {
  const blocks = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return blocks.map((block, index) => {
    if (index % 2 === 1) return block;
    return block
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g, "<$2|$1>")
      .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
      .replace(/__([^_\n]+)__/g, "*$1*")
      .replace(/~~([^~\n]+)~~/g, "~$1~");
  }).join("");
}

export function splitSlackMessage(text: string, limit = 39_000): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
