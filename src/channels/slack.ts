import type { CommunicationProvider, IncomingMessage, MessageHandler, OutboundResponse } from "./types.js";
import { UpdatingResponse } from "./updating-response.js";

interface SlackResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  user_id?: string;
  url?: string;
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
}

interface SlackEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: { event?: SlackEvent };
}

export interface SlackOptions {
  botToken: string;
  appToken: string;
  fetch?: typeof globalThis.fetch;
  webSocket?: typeof WebSocket;
}

/** Slack Socket Mode transport. It needs no public webhook or inbound port. */
export class SlackProvider implements CommunicationProvider {
  readonly name = "slack";
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly WebSocketClass: typeof WebSocket;
  private botUserId = "";

  constructor(private readonly options: SlackOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.WebSocketClass = options.webSocket ?? globalThis.WebSocket;
    if (!this.WebSocketClass) throw new Error("This Node.js runtime does not provide WebSocket support");
  }

  async start(handler: MessageHandler, signal: AbortSignal): Promise<void> {
    const auth = await this.call("auth.test", {}, this.options.botToken, signal);
    this.botUserId = auth.user_id ?? "";

    while (!signal.aborted) {
      try {
        const connection = await this.call("apps.connections.open", {}, this.options.appToken, signal);
        if (!connection.url) throw new Error("Slack did not return a Socket Mode URL");
        await this.consume(connection.url, handler, signal);
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
    let timestamp: string | undefined;
    return new UpdatingResponse({
      // chat.update is generally limited to roughly one request per second per channel.
      minUpdateIntervalMs: 1_000,
      publish: async (text) => {
        const rendered = slackText(text);
        if (!timestamp) {
          const sent = await this.call("chat.postMessage", {
            channel: message.conversationId,
            text: rendered,
            ...(message.threadId ? { thread_ts: message.threadId } : {}),
          }, this.options.botToken, signal);
          if (!sent.ts) throw new Error("Slack did not return a message timestamp");
          timestamp = sent.ts;
        } else {
          await this.call("chat.update", {
            channel: message.conversationId,
            ts: timestamp,
            text: rendered,
          }, this.options.botToken, signal);
        }
      },
    });
  }

  private consume(url: string, handler: MessageHandler, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketClass(url);
      let opened = false;
      const abort = () => socket.close();
      signal.addEventListener("abort", abort, { once: true });

      socket.addEventListener("open", () => { opened = true; });
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
    if (!event || event.bot_id || event.subtype || !event.user || !event.channel || !event.text) return;
    if (event.type !== "message" && event.type !== "app_mention") return;

    const isDirectMessage = event.channel_type === "im";
    const mentionsBot = event.type === "app_mention" || event.text.includes(`<@${this.botUserId}>`);
    if (!isDirectMessage && !mentionsBot) return;
    const text = event.text.replaceAll(`<@${this.botUserId}>`, "").trim();
    if (!text) return;

    await handler({
      provider: this.name,
      conversationId: event.channel,
      senderId: event.user,
      text,
      threadId: isDirectMessage ? event.thread_ts : (event.thread_ts ?? event.ts),
    });
  }

  private async call(
    method: string,
    body: object,
    token: string,
    signal?: AbortSignal,
  ): Promise<SlackResponse> {
    const response = await this.fetchFn(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`Slack returned HTTP ${response.status}`);
    const payload = await response.json() as SlackResponse;
    if (!payload.ok) throw new Error(payload.error ?? `Slack ${method} failed`);
    return payload;
  }
}

function slackText(text: string): string {
  const limit = 39_000;
  if (text.length <= limit) return text;
  return `…${text.slice(-(limit - 1))}`;
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
