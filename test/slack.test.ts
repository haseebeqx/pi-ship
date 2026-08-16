import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackProvider, splitSlackMessage } from "../src/channels/slack.js";
import { hashPairingCode } from "../src/pairing.js";

test("long Slack responses preserve the beginning in continuation messages", () => {
  const parts = splitSlackMessage("abcdefghijkl", 5);
  assert.deepEqual(parts, ["abcde", "fghij", "kl"]);
  assert.equal(parts.join(""), "abcdefghijkl");
});

class FakeWebSocket extends EventTarget {
  static latest: FakeWebSocket | undefined;
  readonly sent: string[] = [];

  constructor(_url: string | URL) {
    super();
    FakeWebSocket.latest = this;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(String(data));
  }

  close(): void {
    this.dispatchEvent(new Event("close"));
  }

  emit(data: object): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

test("Slack only dispatches messages from the paired user", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ship-slack-"));
  const posted: Array<Record<string, unknown>> = [];
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (method === "chat.postMessage") posted.push(body);
    const result = method === "auth.test"
      ? { ok: true, user_id: "BOT" }
      : method === "apps.connections.open"
        ? { ok: true, url: "wss://example.test" }
        : { ok: true, ts: "1" };
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  const provider = new SlackProvider({
    botToken: "xoxb-test",
    appToken: "xapp-test",
    pairingCodeHash: hashPairingCode("SECRET"),
    statePath: join(directory, "state.json"),
    fetch: fetchMock,
    webSocket: FakeWebSocket as unknown as typeof WebSocket,
  });
  const abort = new AbortController();
  const received: string[] = [];
  const started = provider.start(async (message) => { received.push(message.senderId); }, abort.signal);

  await waitFor(() => FakeWebSocket.latest !== undefined);
  const socket = FakeWebSocket.latest!;
  socket.emit(envelope({ type: "message", channel: "DM", channel_type: "im", user: "OWNER", text: "/pair SECRET" }));
  await waitFor(() => posted.length === 1);

  socket.emit(envelope({ type: "app_mention", channel: "C1", user: "OTHER", text: "<@BOT> run shell" }));
  socket.emit(envelope({ type: "app_mention", channel: "C1", user: "OWNER", text: "<@BOT> hello" }));
  await waitFor(() => received.length === 1);
  assert.deepEqual(received, ["OWNER"]);

  abort.abort();
  await started;
  await rm(directory, { recursive: true, force: true });
});

function envelope(event: object): object {
  return { envelope_id: Math.random().toString(), type: "events_api", payload: { event } };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}
