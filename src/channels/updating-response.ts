import type { OutboundResponse } from "./types.js";

export interface UpdatingResponseOptions {
  /** Publish the complete accumulated text. The callback may create or edit messages. */
  publish(text: string): Promise<void>;
  minUpdateIntervalMs?: number;
}

/**
 * Converts token deltas into rate-limited snapshots. The first text is published
 * immediately and completion always flushes the latest snapshot.
 */
export class UpdatingResponse implements OutboundResponse {
  private text = "";
  private status = "";
  private lastPublished = "";
  private lastPublishAt = 0;
  private queue = Promise.resolve();

  constructor(private readonly options: UpdatingResponseOptions) {}

  append(delta: string): Promise<void> {
    if (!delta) return this.queue;
    this.text += delta;
    return this.enqueue(false);
  }

  progress(status?: string): Promise<void> {
    this.status = status?.trim() ?? "";
    return this.enqueue(false);
  }

  complete(fallbackText: string): Promise<void> {
    if (!this.text.trim()) this.text = fallbackText;
    this.status = "";
    return this.enqueue(true);
  }

  fail(message: string): Promise<void> {
    this.text = message;
    this.status = "";
    return this.enqueue(true);
  }

  private enqueue(force: boolean): Promise<void> {
    this.queue = this.queue.then(async () => {
      let snapshot = this.snapshot();
      if (snapshot === this.lastPublished) return;
      if (!force && this.lastPublishAt > 0) {
        const wait = (this.options.minUpdateIntervalMs ?? 750) - (Date.now() - this.lastPublishAt);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
      snapshot = this.snapshot();
      if (snapshot === this.lastPublished) return;
      await this.options.publish(snapshot);
      this.lastPublished = snapshot;
      this.lastPublishAt = Date.now();
    });
    return this.queue;
  }

  private snapshot(): string {
    if (!this.status) return this.text;
    return `${this.text}${this.text ? "\n\n" : ""}⏳ ${this.status}`;
  }
}
