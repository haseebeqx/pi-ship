import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeliveryTracker } from "../src/delivery.js";

test("delivery records survive tracker instances until delivered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ship-delivery-"));
  const first = new DeliveryTracker(directory);
  const id = await first.begin("telegram", "123");
  await first.update(id, { text: "hello", attempts: 1, lastError: "offline" });

  const pending = await new DeliveryTracker(directory).pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.text, "hello");
  assert.equal(pending[0]?.attempts, 1);

  await first.delivered(id);
  assert.deepEqual(await new DeliveryTracker(directory).pending(), []);
  await rm(directory, { recursive: true, force: true });
});
