import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type SessionFactoryContext, type SessionRpc } from "../src/session-manager.js";

class FakeRpc implements SessionRpc {
  started = 0;
  stopped = 0;
  aborted = 0;
  steered: string[] = [];
  followed: string[] = [];
  private listeners = new Set<(event: Record<string, unknown>) => void>();
  constructor(readonly context: SessionFactoryContext<{ id: string }>) {}
  async start() { this.started += 1; }
  async stop() { this.stopped += 1; }
  async prompt() {}
  async abort() { this.aborted += 1; }
  async steer(message: string) { this.steered.push(message); }
  async followUp(message: string) { this.followed.push(message); }
  onEvent(listener: (event: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  fatal(error = new Error("crashed")) { this.context.onFatal(error); }
}

async function fixture(options: Partial<ConstructorParameters<typeof SessionManager<{ id: string }, FakeRpc>>[0]> = {}) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-ship-manager-"));
  const created: FakeRpc[] = [];
  const manager = new SessionManager<{ id: string }, FakeRpc>({
    cwd: process.cwd(), agentDir, key: ({ id }) => id,
    createSession: (context) => {
      const rpc = new FakeRpc(context);
      created.push(rpc);
      return rpc;
    },
    ...options,
  });
  return { manager, created, cleanup: () => rm(agentDir, { recursive: true, force: true }) };
}

test("generic sessions order locally, run across identities, and expose controls", async () => {
  const { manager, created, cleanup } = await fixture();
  let release!: () => void;
  let began!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { began = resolve; });
  const order: string[] = [];
  const first = manager.run({ id: "a" }, async () => { order.push("a1"); began(); await blocked; });
  const second = manager.run({ id: "a" }, async () => { order.push("a2"); });
  const other = manager.run({ id: "b" }, async () => { order.push("b1"); });
  await Promise.all([started, other]);
  assert.equal(order.includes("a1"), true);
  assert.equal(order.includes("b1"), true);
  assert.equal(order.includes("a2"), false);
  await manager.abort({ id: "a" });
  await manager.steer({ id: "a" }, "change");
  await manager.followUp({ id: "a" }, "next");
  const sessionA = created.find((rpc) => rpc.context.identity.id === "a");
  assert.equal(sessionA?.aborted, 1);
  assert.deepEqual(sessionA?.steered, ["change"]);
  assert.deepEqual(sessionA?.followed, ["next"]);
  release();
  await Promise.all([first, second]);
  assert.equal(order.at(-1), "a2");
  await manager.stop();
  await cleanup();
});

test("fatal sessions recover with the same persistent directory", async () => {
  const { manager, created, cleanup } = await fixture();
  await manager.prompt({ id: "a" }, "one");
  created[0]!.fatal();
  await manager.prompt({ id: "a" }, "two");
  assert.equal(created.length, 2);
  assert.equal(created[0]!.context.sessionDir, created[1]!.context.sessionDir);
  await manager.stop();
  await cleanup();
});

test("queue limits reject excess work", async () => {
  const { manager, cleanup } = await fixture({ maxQueueSizePerSession: 1 });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = manager.run({ id: "a" }, async () => blocked);
  await assert.rejects(manager.run({ id: "a" }, async () => undefined), /queue limit/);
  release();
  await first;
  await manager.stop();
  await cleanup();
});

test("idle sessions are evicted", async () => {
  const { manager, created, cleanup } = await fixture({ idleTimeoutMs: 5 });
  await manager.prompt({ id: "a" }, "one");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.size, 0);
  assert.equal(created[0]?.stopped, 1);
  await manager.stop();
  await cleanup();
});
