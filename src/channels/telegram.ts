import type { CommunicationProvider, IncomingMessage, MessageHandler, OutboundResponse } from "./types.js";
import { UpdatingResponse } from "./updating-response.js";
import { pairingCodeMatches, PairingStore } from "../pairing.js";
import { fetchWithRetry } from "./retry.js";

interface TelegramFileRef { file_id: string; file_name?: string; mime_type?: string }

interface TelegramMessage {
  message_id: number;
  text?: string;
  caption?: string;
  chat: { id: number; type: string };
  from?: { id: number; is_bot: boolean };
  photo?: Array<{ file_id: string; width: number; height: number }>;
  document?: TelegramFileRef;
  voice?: TelegramFileRef;
  audio?: TelegramFileRef;
  reply_to_message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  message_reaction?: {
    chat: { id: number; type: string };
    user?: { id: number; is_bot: boolean };
    message_id: number;
    new_reaction: Array<{ type: string; emoji?: string }>;
  };
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

export interface TelegramOptions {
  token: string;
  pairingCodeHash: string;
  statePath: string;
  fetch?: typeof globalThis.fetch;
}

export class TelegramProvider implements CommunicationProvider {
  readonly name = "telegram";
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly store: PairingStore;
  private offset = 0;

  constructor(private readonly options: TelegramOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.store = new PairingStore(options.statePath);
  }

  async start(handler: MessageHandler, signal: AbortSignal, onReady?: () => void): Promise<void> {
    await this.store.load();
    let ready = false;
    while (!signal.aborted) {
      try {
        const updates = await this.call<TelegramUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: ready ? 30 : 0,
          allowed_updates: ["message", "message_reaction"],
        }, signal);
        if (!ready) {
          ready = true;
          onReady?.();
        }
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update, handler, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        console.error(`[telegram] ${(error as Error).message}`);
        await sleep(2_000, signal);
      }
    }
  }

  async send(conversationId: string, text: string, signal?: AbortSignal): Promise<void> {
    for (const part of splitTelegramMessage(text)) {
      await this.call("sendMessage", { chat_id: conversationId, text: part }, signal);
    }
  }

  async openResponse(message: IncomingMessage, signal: AbortSignal): Promise<OutboundResponse> {
    const messageIds: number[] = [];
    const published: string[] = [];
    const showTyping = () => this.call("sendChatAction", {
      chat_id: message.conversationId,
      action: "typing",
    }, signal).catch((error) => {
      if (!signal.aborted) console.error(`[telegram] typing indicator failed: ${(error as Error).message}`);
    });

    // Telegram indicators expire after five seconds, so refresh while Pi is working.
    await showTyping();
    const typingTimer = setInterval(() => void showTyping(), 4_000);
    const stopTyping = () => {
      clearInterval(typingTimer);
      signal.removeEventListener("abort", stopTyping);
    };
    signal.addEventListener("abort", stopTyping, { once: true });

    const response = new UpdatingResponse({
      minUpdateIntervalMs: 1_000,
      publish: async (text) => {
        const parts = splitTelegramMessage(adaptMarkdownForTelegram(text));
        for (let index = 0; index < parts.length; index += 1) {
          const part = parts[index]!;
          if (messageIds[index] === undefined) {
            const sent = await this.call<{ message_id: number }>("sendMessage", {
              chat_id: message.conversationId,
              text: part,
            }, signal);
            messageIds[index] = sent.message_id;
            published[index] = part;
          } else if (published[index] !== part) {
            await this.call("editMessageText", {
              chat_id: message.conversationId,
              message_id: messageIds[index],
              text: part,
            }, signal);
            published[index] = part;
          }
        }
      },
    });
    return {
      append: (delta) => response.append(delta),
      progress: (status) => response.progress(status),
      complete: async (fallbackText) => {
        try {
          await response.complete(fallbackText);
        } finally {
          stopTyping();
        }
      },
      fail: async (errorMessage) => {
        try {
          await response.fail(errorMessage);
        } finally {
          stopTyping();
        }
      },
    };
  }

  private async handleUpdate(update: TelegramUpdate, handler: MessageHandler, signal: AbortSignal): Promise<void> {
    if (update.message_reaction) {
      const reaction = update.message_reaction;
      const senderId = reaction.user?.id.toString();
      if (!senderId || reaction.user?.is_bot || !this.store.has(senderId) || reaction.chat.type !== "private") return;
      const emoji = reaction.new_reaction.map((item) => item.emoji ?? item.type).join(" ") || "removed";
      await handler({
        provider: this.name,
        conversationId: reaction.chat.id.toString(),
        senderId,
        text: `[Reaction ${emoji} on message ${reaction.message_id}]`,
      });
      return;
    }

    const message = update.message;
    const senderId = message?.from?.id.toString();
    const conversationId = message?.chat.id.toString();
    const text = (message?.text ?? message?.caption ?? "").trim();
    if (!message || !senderId || !conversationId || message.from?.is_bot) return;

    if (message.chat.type !== "private") {
      await this.send(conversationId, "For safety, this Pi only accepts private messages.", signal);
      return;
    }

    if (!this.store.has(senderId)) {
      if (this.store.hasAny()) {
        await this.send(conversationId, "This Pi is already paired with its owner.", signal);
        return;
      }
      const match = text.match(/^\/pair\s+(.+)$/i);
      if (match?.[1] && pairingCodeMatches(match[1], this.options.pairingCodeHash)) {
        await this.store.add(senderId);
        await this.send(conversationId, "Paired. This Pi will now respond only to your account.", signal);
      } else {
        await this.send(conversationId, "This Pi is private. Send /pair followed by the code shown during deployment.", signal);
      }
      return;
    }

    const attachments = await this.downloadAttachments(message, signal);
    if (!text && attachments.length === 0) return;
    const replied = message.reply_to_message;
    await handler({
      provider: this.name,
      conversationId,
      senderId,
      text,
      ...(attachments.length ? { attachments } : {}),
      ...(replied ? { replyTo: {
        senderId: replied.from?.id.toString(),
        text: (replied.text ?? replied.caption ?? "").trim() || undefined,
        messageId: replied.message_id.toString(),
      } } : {}),
    });
  }

  private async downloadAttachments(message: TelegramMessage, signal: AbortSignal) {
    const refs: Array<{ kind: "image" | "document" | "audio"; ref: TelegramFileRef; fallback: string }> = [];
    const photo = message.photo?.at(-1);
    if (photo) refs.push({ kind: "image", ref: photo, fallback: `photo-${message.message_id}.jpg` });
    if (message.document) refs.push({ kind: message.document.mime_type?.startsWith("image/") ? "image" : "document", ref: message.document, fallback: `document-${message.message_id}` });
    if (message.voice) refs.push({ kind: "audio", ref: message.voice, fallback: `voice-${message.message_id}.ogg` });
    if (message.audio) refs.push({ kind: "audio", ref: message.audio, fallback: `audio-${message.message_id}` });

    return Promise.all(refs.map(async ({ kind, ref, fallback }) => {
      const file = await this.call<{ file_path: string }>("getFile", { file_id: ref.file_id }, signal);
      const response = await this.fetchFn(`https://api.telegram.org/file/bot${this.options.token}/${file.file_path}`, { signal });
      if (!response.ok) throw new Error(`Telegram file download returned HTTP ${response.status}`);
      return {
        kind,
        fileName: ref.file_name ?? file.file_path.split("/").at(-1) ?? fallback,
        mimeType: ref.mime_type ?? (kind === "image" ? "image/jpeg" : kind === "audio" ? "audio/ogg" : "application/octet-stream"),
        data: Buffer.from(await response.arrayBuffer()).toString("base64"),
      };
    }));
  }

  private async call<T>(method: string, body: object, signal?: AbortSignal): Promise<T> {
    const response = await fetchWithRetry(() => this.fetchFn(`https://api.telegram.org/bot${this.options.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }), { signal });
    if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
    const payload = await response.json() as TelegramResponse<T>;
    if (!payload.ok) throw new Error(payload.description ?? `Telegram ${method} failed`);
    return payload.result;
  }
}

/** Adapt unsupported CommonMark constructs while retaining Telegram-readable plain text. */
export function adaptMarkdownForTelegram(text: string): string {
  const blocks = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return blocks.map((block, index) => {
    if (index % 2 === 1) return block;
    return block
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g, "$1 ($2)");
  }).join("");
}

export function splitTelegramMessage(text: string, limit = 4000): string[] {
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
