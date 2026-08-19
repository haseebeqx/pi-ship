import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PiRpc, type PiRpcEvent, type PiRpcImage, type PiRpcOptions } from "./rpc.js";

/** The subset of PiRpc required by the reusable session runtime. */
export interface SessionRpc {
  start(): Promise<void>;
  stop(): Promise<void>;
  prompt(message: string, images?: PiRpcImage[]): Promise<void>;
  abort?(): Promise<void>;
  steer?(message: string, images?: PiRpcImage[]): Promise<void>;
  followUp?(message: string, images?: PiRpcImage[]): Promise<void>;
  onEvent(listener: (event: PiRpcEvent) => void): () => void;
}

export interface SessionFactoryContext<Identity> {
  identity: Identity;
  key: string;
  /** Stable, private directory for this identity. */
  sessionDir: string;
  cwd: string;
  agentDir: string;
  /** Factories must call this if their runtime dies after start-up. */
  onFatal(error: Error): void;
}

export type SessionManagerEvent<Identity> =
  | { type: "session_created"; identity: Identity; key: string }
  | { type: "session_starting" | "session_started" | "session_stopping" | "session_stopped" | "session_evicted"; identity: Identity; key: string }
  | { type: "session_fatal"; identity: Identity; key: string; error: Error }
  | { type: "task_queued" | "task_started" | "task_completed"; identity: Identity; key: string; queued: number }
  | { type: "task_failed"; identity: Identity; key: string; queued: number; error: Error }
  | { type: "rpc_event"; identity: Identity; key: string; event: PiRpcEvent };

export interface SessionManagerOptions<Identity, Rpc extends SessionRpc = PiRpc> {
  cwd: string;
  agentDir: string;
  /** Converts an application-defined identity to a stable key. */
  key?: (identity: Identity) => string;
  /** Defaults to <agentDir>/ship-sessions. */
  sessionRoot?: string;
  createRpc?: (options: PiRpcOptions, context: SessionFactoryContext<Identity>) => Rpc;
  /** A more general factory. Takes precedence over createRpc. */
  createSession?: (context: SessionFactoryContext<Identity>) => Rpc | Promise<Rpc>;
  /** Stop and remove inactive sessions after this many milliseconds. Disabled by default. */
  idleTimeoutMs?: number;
  /** Maximum identities retained at once. Defaults to Infinity. */
  maxSessions?: number;
  /** Maximum running tasks across identities. Defaults to Infinity. */
  maxConcurrentSessions?: number;
  /** Maximum outstanding tasks for one identity. Defaults to Infinity. */
  maxQueueSizePerSession?: number;
  /** Maximum outstanding tasks across all identities. Defaults to Infinity. */
  maxTotalQueueSize?: number;
  onFatal?: (key: string, error: Error, identity: Identity) => void;
}

/**
 * Orchestrates persistent Pi RPC sessions without imposing transport concepts.
 * Work is FIFO for one identity and concurrent between different identities.
 */
export class SessionManager<Identity, Rpc extends SessionRpc = PiRpc> {
  private readonly sessions = new Map<string, ManagedSession<Identity, Rpc>>();
  private readonly listeners = new Set<(event: SessionManagerEvent<Identity>) => void>();
  private readonly options: SessionManagerOptions<Identity, Rpc>;
  private readonly limiter: Limiter;
  private stopping = false;
  private outstanding = 0;

  constructor(options: SessionManagerOptions<Identity, Rpc>) {
    validateLimit("idleTimeoutMs", options.idleTimeoutMs, true);
    validateLimit("maxSessions", options.maxSessions);
    validateLimit("maxConcurrentSessions", options.maxConcurrentSessions);
    validateLimit("maxQueueSizePerSession", options.maxQueueSizePerSession);
    validateLimit("maxTotalQueueSize", options.maxTotalQueueSize);
    this.options = options;
    this.limiter = new Limiter(options.maxConcurrentSessions ?? Infinity);
  }

  get size(): number { return this.sessions.size; }

  onEvent(listener: (event: SessionManagerEvent<Identity>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe only to events belonging to one identity. */
  subscribe(identity: Identity, listener: (event: SessionManagerEvent<Identity>) => void): () => void {
    const key = this.key(identity);
    return this.onEvent((event) => { if (event.key === key) listener(event); });
  }

  run<T>(identity: Identity, task: (rpc: Rpc) => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error("Session manager is shutting down"));
    if (this.outstanding >= (this.options.maxTotalQueueSize ?? Infinity)) {
      return Promise.reject(new Error("Session manager queue limit reached"));
    }

    let session: ManagedSession<Identity, Rpc>;
    try { session = this.getOrCreate(identity); } catch (error) { return Promise.reject(error); }
    if (session.outstanding >= (this.options.maxQueueSizePerSession ?? Infinity)) {
      return Promise.reject(new Error(`Session queue limit reached for ${session.key}`));
    }

    this.outstanding += 1;
    const work = session.run(task);
    void work.then(
      () => { this.outstanding -= 1; },
      () => { this.outstanding -= 1; },
    );
    return work;
  }

  prompt(identity: Identity, message: string, images?: PiRpcImage[]): Promise<void> {
    return this.run(identity, (rpc) => rpc.prompt(message, images));
  }

  /** Controls bypass the FIFO queue so they can affect active work. */
  abort(identity: Identity): Promise<boolean> { return this.control(identity, "abort", []); }
  steer(identity: Identity, message: string, images?: PiRpcImage[]): Promise<boolean> {
    return this.control(identity, "steer", [message, images]);
  }
  followUp(identity: Identity, message: string, images?: PiRpcImage[]): Promise<boolean> {
    return this.control(identity, "followUp", [message, images]);
  }

  /** Evict an inactive identity. Returns false when absent or busy. */
  async evict(identity: Identity): Promise<boolean> {
    const session = this.sessions.get(this.key(identity));
    if (!session || session.busy) return false;
    return this.remove(session, "session_evicted");
  }

  /** Drop an inactive runtime but retain its identity and persistent state. */
  async recover(identity: Identity): Promise<boolean> {
    const session = this.sessions.get(this.key(identity));
    if (!session || session.busy) return false;
    await session.recover();
    return true;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await Promise.allSettled([...this.sessions.values()].map((session) => this.remove(session, "session_stopped", true)));
    this.sessions.clear();
  }

  private key(identity: Identity): string {
    const key = this.options.key ? this.options.key(identity) : defaultKey(identity);
    if (!key) throw new Error("Session identity key must not be empty");
    return key;
  }

  private getOrCreate(identity: Identity): ManagedSession<Identity, Rpc> {
    const key = this.key(identity);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const max = this.options.maxSessions ?? Infinity;
    if (this.sessions.size >= max) {
      const idle = [...this.sessions.values()].filter((item) => !item.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (idle) void this.remove(idle, "session_evicted");
      // Removal from the map is synchronous, even though stopping the RPC is not.
      if (this.sessions.size >= max) throw new Error("Session resource limit reached");
    }

    const digest = createHash("sha256").update(key).digest("hex");
    const session = new ManagedSession({
      identity, key,
      cwd: this.options.cwd,
      agentDir: this.options.agentDir,
      sessionDir: join(this.options.sessionRoot ?? join(this.options.agentDir, "ship-sessions"), digest),
      idleTimeoutMs: this.options.idleTimeoutMs,
      limiter: this.limiter,
      factory: (context) => this.create(context),
      emit: (event) => this.emit(event),
      idle: (candidate) => { if (this.sessions.get(key) === candidate) void this.remove(candidate, "session_evicted"); },
      fatal: (error) => this.options.onFatal?.(key, error, identity),
    });
    this.sessions.set(key, session);
    this.emit({ type: "session_created", identity, key });
    return session;
  }

  private async create(context: SessionFactoryContext<Identity>): Promise<Rpc> {
    if (this.options.createSession) return this.options.createSession(context);
    const factory = this.options.createRpc ?? ((options: PiRpcOptions) => new PiRpc(options) as unknown as Rpc);
    return factory({ cwd: context.cwd, agentDir: context.agentDir, sessionDir: context.sessionDir, onFatal: context.onFatal }, context);
  }

  private async control(identity: Identity, method: "abort" | "steer" | "followUp", args: unknown[]): Promise<boolean> {
    const session = this.sessions.get(this.key(identity));
    const rpc = session?.client;
    const fn = rpc?.[method] as ((...values: unknown[]) => Promise<void>) | undefined;
    if (!fn) return false;
    await fn.apply(rpc, args);
    return true;
  }

  private async remove(session: ManagedSession<Identity, Rpc>, event: "session_evicted" | "session_stopped", force = false): Promise<boolean> {
    if (!force && session.busy) return false;
    if (this.sessions.get(session.key) !== session) return false;
    this.sessions.delete(session.key);
    try {
      await session.stop();
    } finally {
      this.emit({ type: event, identity: session.identity, key: session.key });
    }
    return true;
  }

  private emit(event: SessionManagerEvent<Identity>): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* A consumer listener cannot break orchestration. */ }
    }
  }
}

interface ManagedOptions<I, R extends SessionRpc> extends SessionFactoryContext<I> {
  idleTimeoutMs?: number;
  limiter: Limiter;
  factory: (context: SessionFactoryContext<I>) => Promise<R>;
  emit: (event: SessionManagerEvent<I>) => void;
  idle: (session: ManagedSession<I, R>) => void;
  fatal: (error: Error) => void;
  onFatal(error: Error): void;
}

class ManagedSession<I, R extends SessionRpc> {
  readonly identity: I;
  readonly key: string;
  outstanding = 0;
  lastUsed = Date.now();
  client: R | undefined;
  private readonly options: ManagedOptions<I, R>;
  private queue = Promise.resolve();
  private closed = false;
  private active = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(options: Omit<ManagedOptions<I, R>, "onFatal">) {
    this.options = { ...options, onFatal: (error) => this.fatal(error) };
    this.identity = options.identity;
    this.key = options.key;
  }

  get busy(): boolean { return this.active || this.outstanding > 0; }

  run<T>(task: (rpc: R) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Session is closed"));
    clearTimeout(this.idleTimer);
    this.outstanding += 1;
    this.options.emit({ type: "task_queued", identity: this.identity, key: this.key, queued: this.outstanding });
    const work = this.queue.then(async () => {
      let release: (() => void) | undefined;
      try {
        if (this.closed) throw new Error("Session is closed");
        release = await this.options.limiter.acquire();
        this.active = true;
        this.options.emit({ type: "task_started", identity: this.identity, key: this.key, queued: this.outstanding - 1 });
        const result = await task(await this.getClient());
        this.options.emit({ type: "task_completed", identity: this.identity, key: this.key, queued: this.outstanding - 1 });
        return result;
      } catch (value) {
        const error = asError(value);
        this.options.emit({ type: "task_failed", identity: this.identity, key: this.key, queued: this.outstanding - 1, error });
        throw value;
      } finally {
        this.active = false;
        release?.();
        this.outstanding -= 1;
        this.lastUsed = Date.now();
        if (this.outstanding === 0) this.scheduleIdle();
      }
    });
    this.queue = work.then(() => undefined, () => undefined);
    return work;
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    await this.queue;
    await this.stopClient();
  }

  async recover(): Promise<void> {
    clearTimeout(this.idleTimer);
    await this.stopClient();
    this.lastUsed = Date.now();
    this.scheduleIdle();
  }

  private async getClient(): Promise<R> {
    if (this.client) return this.client;
    await mkdir(this.options.sessionDir, { recursive: true });
    this.options.emit({ type: "session_starting", identity: this.identity, key: this.key });
    const rpc = await this.options.factory(this.options);
    this.client = rpc;
    this.unsubscribe = rpc.onEvent((event) => this.options.emit({ type: "rpc_event", identity: this.identity, key: this.key, event }));
    try {
      await rpc.start();
      if (this.client !== rpc) throw new Error("Session runtime failed during startup");
      this.options.emit({ type: "session_started", identity: this.identity, key: this.key });
      return rpc;
    } catch (value) {
      if (this.client === rpc) this.client = undefined;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      await rpc.stop().catch(() => undefined);
      throw value;
    }
  }

  private fatal(error: Error): void {
    const rpc = this.client;
    if (!rpc) return;
    this.client = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    // The stable session directory lets the next queued/new task recover.
    void rpc.stop().catch(() => undefined);
    this.options.emit({ type: "session_fatal", identity: this.identity, key: this.key, error });
    this.options.fatal(error);
  }

  private async stopClient(): Promise<void> {
    const rpc = this.client;
    this.client = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (!rpc) return;
    this.options.emit({ type: "session_stopping", identity: this.identity, key: this.key });
    await rpc.stop();
  }

  private scheduleIdle(): void {
    const timeout = this.options.idleTimeoutMs;
    if (timeout === undefined || timeout === Infinity) return;
    this.idleTimer = setTimeout(() => {
      if (!this.busy && Date.now() - this.lastUsed >= timeout) this.options.idle(this);
    }, timeout);
    this.idleTimer.unref?.();
  }
}

class Limiter {
  private active = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];
  constructor(private readonly maximum: number) {}
  acquire(): Promise<() => void> {
    if (this.active < this.maximum) {
      this.active += 1;
      return Promise.resolve(this.releaseFn());
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  private releaseFn(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(this.releaseFn());
      else this.active -= 1;
    };
  }
}

function defaultKey(value: unknown): string {
  if (typeof value === "string") return value;
  const seen = new Set<object>();
  const stable = (item: unknown): unknown => {
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) throw new Error("Session identity must not be cyclic");
    seen.add(item);
    const result = Array.isArray(item)
      ? item.map(stable)
      : Object.fromEntries(Object.keys(item).sort().map((key) => [key, stable((item as Record<string, unknown>)[key])]));
    seen.delete(item);
    return result;
  };
  const key = JSON.stringify(stable(value));
  if (key === undefined) throw new Error("Session identity requires a key function");
  return key;
}
function validateLimit(name: string, value: number | undefined, allowZero = false): void {
  if (value === undefined || value === Infinity) return;
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
}
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
