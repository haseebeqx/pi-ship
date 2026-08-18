import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DeliveryRecord {
  id: string;
  provider: string;
  conversationId: string;
  text: string;
  status: "pending" | "delivered";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

/** Atomic, process-restart-safe tracking for final and proactive messages. */
export class DeliveryTracker {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  async begin(provider: string, conversationId: string, text = ""): Promise<string> {
    const now = new Date().toISOString();
    const record: DeliveryRecord = {
      id: randomUUID(), provider, conversationId, text,
      status: "pending", attempts: 0, createdAt: now, updatedAt: now,
    };
    await this.save(record);
    return record.id;
  }

  update(id: string, update: Partial<Pick<DeliveryRecord, "text" | "status" | "attempts" | "lastError">>): Promise<void> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const work = previous.then(async () => {
      const record = await this.read(id);
      if (!record) return;
      Object.assign(record, update, { updatedAt: new Date().toISOString() });
      if (!update.lastError) delete record.lastError;
      await this.save(record);
    });
    const queued = work.catch(() => undefined);
    this.queues.set(id, queued);
    void queued.finally(() => {
      if (this.queues.get(id) === queued) this.queues.delete(id);
    });
    return work;
  }

  delivered(id: string, text?: string): Promise<void> {
    return this.update(id, { ...(text === undefined ? {} : { text }), status: "delivered" });
  }

  async pending(): Promise<DeliveryRecord[]> {
    await mkdir(this.directory, { recursive: true });
    const names = await readdir(this.directory);
    const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      try { return JSON.parse(await readFile(join(this.directory, name), "utf8")) as DeliveryRecord; }
      catch { return undefined; }
    }));
    return records.filter((record): record is DeliveryRecord => record?.status === "pending" && Boolean(record.text));
  }

  private async read(id: string): Promise<DeliveryRecord | undefined> {
    try { return JSON.parse(await readFile(this.path(id), "utf8")) as DeliveryRecord; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async save(record: DeliveryRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = this.path(record.id);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  private path(id: string): string {
    return join(this.directory, `${id}.json`);
  }
}
