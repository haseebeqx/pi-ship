export interface IncomingMessage {
  provider: string;
  conversationId: string;
  senderId: string;
  text: string;
  /** Provider-specific parent message identifier (for example, a Slack thread timestamp). */
  threadId?: string;
}

export type MessageHandler = (message: IncomingMessage) => Promise<void>;

/** A progressively rendered provider response. Implementations serialize concurrent calls in invocation order. */
export interface OutboundResponse {
  append(delta: string): Promise<void>;
  complete(fallbackText: string): Promise<void>;
  fail(message: string): Promise<void>;
}

/** A communication provider transports messages; it knows nothing about Pi. */
export interface CommunicationProvider {
  readonly name: string;
  start(handler: MessageHandler, signal: AbortSignal): Promise<void>;
  send(conversationId: string, text: string, signal?: AbortSignal): Promise<void>;
  /** Providers can implement this to edit/stream a response in real time. */
  openResponse?(message: IncomingMessage, signal: AbortSignal): Promise<OutboundResponse>;
}

/** Compatibility path for providers which can only send a completed message. */
export function bufferedResponse(
  provider: CommunicationProvider,
  message: IncomingMessage,
  signal: AbortSignal,
): OutboundResponse {
  let text = "";
  return {
    async append(delta) { text += delta; },
    async complete(fallbackText) {
      await provider.send(message.conversationId, text.trim() || fallbackText, signal);
    },
    async fail(errorMessage) {
      await provider.send(message.conversationId, errorMessage, signal);
    },
  };
}
