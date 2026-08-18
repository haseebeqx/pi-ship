import assert from "node:assert/strict";
import test from "node:test";
import { UpdatingResponse } from "../src/channels/updating-response.js";
import { bufferedResponse, type CommunicationProvider } from "../src/channels/types.js";

test("updating responses publish deltas as cumulative snapshots", async () => {
  const snapshots: string[] = [];
  const response = new UpdatingResponse({
    minUpdateIntervalMs: 0,
    publish: async (text) => { snapshots.push(text); },
  });

  await response.append("Hello");
  await response.append(" world");
  await response.complete("unused");

  assert.deepEqual(snapshots, ["Hello", "Hello world"]);
});

test("updating responses render transient progress and remove it on completion", async () => {
  const snapshots: string[] = [];
  const response = new UpdatingResponse({
    minUpdateIntervalMs: 0,
    publish: async (text) => { snapshots.push(text); },
  });

  await response.progress("Using bash");
  await response.append("Done");
  await response.complete("unused");
  assert.deepEqual(snapshots, ["⏳ Using bash", "Done\n\n⏳ Using bash", "Done"]);
});

test("updating responses publish fallback text when Pi emits no text", async () => {
  const snapshots: string[] = [];
  const response = new UpdatingResponse({
    publish: async (text) => { snapshots.push(text); },
  });

  await response.complete("Done");
  assert.deepEqual(snapshots, ["Done"]);
});

test("non-streaming providers buffer deltas until completion", async () => {
  const sent: string[] = [];
  const provider: CommunicationProvider = {
    name: "test",
    async start() {},
    async send(_conversationId, text) { sent.push(text); },
  };
  const response = bufferedResponse(provider, {
    provider: "test",
    conversationId: "channel",
    senderId: "user",
    text: "question",
  }, new AbortController().signal);

  await response.append("one");
  await response.append(" two");
  assert.deepEqual(sent, []);
  await response.complete("unused");
  assert.deepEqual(sent, ["one two"]);
});
