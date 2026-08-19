import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage } from "./channels/types.js";
import { PiRpc, type PiRpcEvent, type PiRpcImage, type PiRpcOptions } from "./rpc.js";

export type ConversationIdentity = Pick<IncomingMessage, "provider" | "conversationId" | "threadId">;

export interface ConversationRpc {
  start(): Promise<void>;
  stop(): Promise<void>;
  prompt(message: string, images?: PiRpcImage[]): Promise<void>;
  abort?(): Promise<void>;
  steer?(message: string, images?: PiRpcImage[]): Promise<void>;
  followUp?(message: string, images?: PiRpcImage[]): Promise<void>;
  newSession?(parentSession?: string): Promise<unknown>;
  getState?(): Promise<unknown>;
  setModel?(provider: string, modelId: string): Promise<unknown>;
  getAvailableModels?(): Promise<unknown[]>;
  setThinkingLevel?(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"): Promise<void>;
  getSessionStats?(): Promise<unknown>;
  getCommands?(): Promise<unknown[]>;
  onEvent(listener: (event: PiRpcEvent) => void): () => void;
}

export interface ConversationSessionsOptions {
  cwd: string;
  agentDir: string;
  createRpc?: (options: PiRpcOptions) => ConversationRpc;
  onFatal?: (conversationKey: string, error: Error) => void;
}

/** A stable identity for one provider conversation (or one provider thread). */
export function conversationKey(message: ConversationIdentity): string {
  return JSON.stringify([message.provider, message.conversationId, message.threadId ?? null]);
}

/**
 * Owns one persistent Pi session per conversation. Prompts in the same
 * conversation are ordered, while prompts in different conversations run in
 * parallel.
 */
export class ConversationSessions {
  private readonly sessions = new Map<string, ConversationSession>();
  private readonly options: ConversationSessionsOptions;
  private stopping = false;

  constructor(options: ConversationSessionsOptions) {
    this.options = options;
  }

  run<T>(message: ConversationIdentity, task: (rpc: ConversationRpc) => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error("Conversation sessions are shutting down"));

    const key = conversationKey(message);
    let session = this.sessions.get(key);
    if (!session) {
      const digest = createHash("sha256").update(key).digest("hex");
      session = new ConversationSession({
        key,
        cwd: this.options.cwd,
        agentDir: this.options.agentDir,
        sessionDir: join(this.options.agentDir, "ship-sessions", digest),
        createRpc: this.options.createRpc ?? ((options) => new PiRpc(options)),
        onFatal: this.options.onFatal,
      });
      this.sessions.set(key, session);
    }
    return session.run(task);
  }

  /** Abort active work immediately without waiting behind the conversation queue. */
  async abort(message: ConversationIdentity): Promise<boolean> {
    const session = this.sessions.get(conversationKey(message));
    return session ? session.abort() : false;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await Promise.allSettled([...this.sessions.values()].map((session) => session.stop()));
  }
}

interface ConversationSessionOptions {
  key: string;
  cwd: string;
  agentDir: string;
  sessionDir: string;
  createRpc: (options: PiRpcOptions) => ConversationRpc;
  onFatal?: (conversationKey: string, error: Error) => void;
}

class ConversationSession {
  private readonly options: ConversationSessionOptions;
  private queue = Promise.resolve();
  private rpc: ConversationRpc | undefined;
  private closed = false;

  constructor(options: ConversationSessionOptions) {
    this.options = options;
  }

  run<T>(task: (rpc: ConversationRpc) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Conversation session is closed"));

    const work = this.queue.then(async () => {
      if (this.closed) throw new Error("Conversation session is closed");
      return task(await this.client());
    });
    // Keep this conversation's queue usable after an individual prompt fails.
    this.queue = work.then(() => undefined, () => undefined);
    return work;
  }

  async abort(): Promise<boolean> {
    if (!this.rpc?.abort) return false;
    await this.rpc.abort();
    return true;
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const rpc = this.rpc;
    this.rpc = undefined;
    if (rpc) await rpc.stop();
    await this.queue;
  }

  private async client(): Promise<ConversationRpc> {
    if (this.rpc) return this.rpc;

    await mkdir(this.options.sessionDir, { recursive: true });
    let rpc!: ConversationRpc;
    rpc = this.options.createRpc({
      cwd: this.options.cwd,
      agentDir: this.options.agentDir,
      sessionDir: this.options.sessionDir,
      onFatal: (error) => {
        if (this.rpc === rpc) this.rpc = undefined;
        this.options.onFatal?.(this.options.key, error);
      },
    });
    this.rpc = rpc;
    try {
      await rpc.start();
      return rpc;
    } catch (error) {
      if (this.rpc === rpc) this.rpc = undefined;
      await rpc.stop().catch(() => undefined);
      throw error;
    }
  }
}
