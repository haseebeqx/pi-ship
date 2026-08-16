import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface PairingState {
  allowedSenderIds: string[];
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

export function pairingCodeMatches(code: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashPairingCode(code), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class PairingStore {
  private allowed = new Set<string>();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8")) as PairingState;
      this.allowed = new Set(state.allowedSenderIds);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  has(senderId: string): boolean {
    return this.allowed.has(senderId);
  }

  hasAny(): boolean {
    return this.allowed.size > 0;
  }

  async add(senderId: string): Promise<void> {
    this.allowed.add(senderId);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ allowedSenderIds: [...this.allowed] }, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.path);
  }
}
