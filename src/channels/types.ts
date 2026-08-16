export interface IncomingMessage {
  provider: string;
  conversationId: string;
  senderId: string;
  text: string;
}

export type MessageHandler = (message: IncomingMessage) => Promise<void>;

/** A communication provider transports messages; it knows nothing about Pi. */
export interface CommunicationProvider {
  readonly name: string;
  start(handler: MessageHandler, signal: AbortSignal): Promise<void>;
  send(conversationId: string, text: string, signal?: AbortSignal): Promise<void>;
}
