import assert from "node:assert/strict";
import test from "node:test";
import {
  PiRpc,
  configureChannel,
  connect,
  deploy,
  logs,
  status,
  update,
  updatePi,
} from "../src/index.js";

test("public library entry point is side-effect free and exports its API", () => {
  for (const value of [PiRpc, configureChannel, connect, deploy, logs, status, update, updatePi]) {
    assert.equal(typeof value, "function");
  }
});

test("PiRpc rejects commands before it is started", async () => {
  const pi = new PiRpc({ cwd: process.cwd(), agentDir: "/tmp/pi-ship-test-agent" });
  await assert.rejects(pi.send({ type: "get_state" }), /not running/);
});
