import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashPairingCode, pairingCodeMatches, PairingStore } from "../src/pairing.js";

test("pairing codes are normalized and compared", () => {
  const hash = hashPairingCode("Happy-Panda-42");
  assert.equal(pairingCodeMatches(" happy-panda-42 ", hash), true);
  assert.equal(pairingCodeMatches("other", hash), false);
});

test("pairing store persists approved senders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ship-test-"));
  const path = join(directory, "state.json");
  try {
    const first = new PairingStore(path);
    await first.load();
    assert.equal(first.has("123"), false);
    assert.equal(first.hasAny(), false);
    await first.add("123");

    const second = new PairingStore(path);
    await second.load();
    assert.equal(second.has("123"), true);
    assert.equal(second.hasAny(), true);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { allowedSenderIds: ["123"] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
