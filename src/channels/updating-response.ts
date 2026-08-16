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
  private lastPublished = "";
  private lastPublishAt = 0;
  private queue = Promise.resolve();

  constructor(private readonly options: UpdatingResponseOptions) {}

  append(delta: string): Promise<void> {
    if (!delta) return this.queue;
    this.text += delta;
    return this.enqueue(false);
  }

  complete(fallbackText: string): Promise<void> {
    if (!this.text.trim()) this.text = fallbackText;
    return this.enqueue(true);
  }

  fail(message: string): Promise<void> {
    this.text = message;
    return this.enqueue(true);
  }

  private enqueue(force: boolean): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.text === this.lastPublished) return;
      if (!force && this.lastPublishAt > 0) {
        const wait = (this.options.minUpdateIntervalMs ?? 750) - (Date.now() - this.lastPublishAt);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
      if (this.text === this.lastPublished) return;
      await this.options.publish(this.text);
      this.lastPublished = this.text;
      this.lastPublishAt = Date.now();
    });
    return this.queue;
  }
}
