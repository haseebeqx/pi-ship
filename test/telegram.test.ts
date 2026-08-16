import assert from "node:assert/strict";
import test from "node:test";
import { splitTelegramMessage } from "../src/channels/telegram.js";

test("short Telegram messages remain intact", () => {
  assert.deepEqual(splitTelegramMessage("hello", 10), ["hello"]);
});

test("long Telegram messages prefer newline boundaries", () => {
  assert.deepEqual(splitTelegramMessage("12345\n67890\nabc", 11), ["12345\n67890", "abc"]);
});

test("long lines are split at the hard limit", () => {
  assert.deepEqual(splitTelegramMessage("abcdefghijkl", 5), ["abcde", "fghij", "kl"]);
});
