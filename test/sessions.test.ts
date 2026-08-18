import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PiRpcOptions } from "../src/rpc.js";
import { ConversationSessions, conversationKey, type ConversationRpc } from "../src/sessions.js";

class FakeRpc implements ConversationRpc {
  constructor(readonly options: PiRpcOptions) {}
  async start() {}
  async stop() {}
  async prompt() {}
  onEvent() { return () => undefined; }
}

test("conversation keys isolate providers, conversations, and threads", () => {
  const base = { provider: "slack", conversationId: "C1" };
  assert.notEqual(conversationKey(base), conversationKey({ ...base, provider: "telegram" }));
  assert.notEqual(conversationKey(base), conversationKey({ ...base, conversationId: "C2" }));
  assert.notEqual(conversationKey(base), conversationKey({ ...base, threadId: "T1" }));
  assert.equal(conversationKey({ ...base, threadId: "T1" }), conversationKey({ ...base, threadId: "T1" }));
});

test("conversation sessions serialize locally and run different conversations concurrently", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-ship-sessions-"));
  const created: FakeRpc[] = [];
  const sessions = new ConversationSessions({
    cwd: process.cwd(),
    agentDir,
    createRpc: (options) => {
      const rpc = new FakeRpc(options);
      created.push(rpc);
      return rpc;
    },
  });

  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let markOtherStarted!: () => void;
  const otherStarted = new Promise<void>((resolve) => { markOtherStarted = resolve; });
  let sameConversationStarted = false;
  const first = sessions.run({ provider: "slack", conversationId: "C1", threadId: "T1" }, async () => {
    markFirstStarted();
    await firstBlocked;
  });
  const same = sessions.run({ provider: "slack", conversationId: "C1", threadId: "T1" }, async () => {
    sameConversationStarted = true;
  });
  const other = sessions.run({ provider: "slack", conversationId: "C1", threadId: "T2" }, async () => {
    markOtherStarted();
  });

  await Promise.all([firstStarted, otherStarted]);
  assert.equal(sameConversationStarted, false);
  assert.equal(created.length, 2);
  assert.notEqual(created[0]?.options.sessionDir, created[1]?.options.sessionDir);

  releaseFirst();
  await Promise.all([first, same, other]);
  assert.equal(sameConversationStarted, true);
  assert.equal(created.length, 2, "the same conversation reuses its Pi process");

  await sessions.stop();
  await rm(agentDir, { recursive: true, force: true });
});
