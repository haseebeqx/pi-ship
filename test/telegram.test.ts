import assert from "node:assert/strict";
import test from "node:test";
import { splitTelegramMessage, TelegramProvider } from "../src/channels/telegram.js";

test("short Telegram messages remain intact", () => {
  assert.deepEqual(splitTelegramMessage("hello", 10), ["hello"]);
});

test("long Telegram messages prefer newline boundaries", () => {
  assert.deepEqual(splitTelegramMessage("12345\n67890\nabc", 11), ["12345\n67890", "abc"]);
});

test("long lines are split at the hard limit", () => {
  assert.deepEqual(splitTelegramMessage("abcdefghijkl", 5), ["abcde", "fghij", "kl"]);
});

test("Telegram shows typing while a response is being generated", async () => {
  const methods: string[] = [];
  const fetchMock = (async (input: string | URL | Request) => {
    const method = String(input).split("/").at(-1)!;
    methods.push(method);
    return new Response(JSON.stringify({
      ok: true,
      result: method === "sendMessage" ? { message_id: 42 } : true,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const provider = new TelegramProvider({
    token: "token",
    pairingCodeHash: "hash",
    statePath: "/unused",
    fetch: fetchMock,
  });
  const response = await provider.openResponse({
    provider: "telegram",
    conversationId: "123",
    senderId: "456",
    text: "hello",
  }, new AbortController().signal);

  await response.complete("Done");
  assert.deepEqual(methods, ["sendChatAction", "sendMessage"]);
});
