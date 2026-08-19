import assert from "node:assert/strict";
import test from "node:test";
import {
  PiRpc,
  configureChannel,
  connect,
  connectRpc,
  deploy,
  logs,
  status,
  update,
  updatePi,
  runtimePiArgs,
  validateRuntimeProfile,
  validateRuntimeSecrets,
} from "../src/index.js";

test("public library entry point is side-effect free and exports its API", () => {
  for (const value of [PiRpc, configureChannel, connect, connectRpc, deploy, logs, status, update, updatePi]) {
    assert.equal(typeof value, "function");
  }
});

test("generic runtime profiles build Pi policy without mixing in secrets", () => {
  const profile = {
    environment: { APP_MODE: "test" },
    tools: ["read", "bash"],
    model: { provider: "test-provider", id: "test-model" },
    piArgs: ["--thinking", "low"],
    readWriteDirectories: ["/srv/state"],
    resources: { maxSessions: 2 },
  } as const;
  validateRuntimeProfile(profile);
  validateRuntimeSecrets({ secretFiles: { token: "super-secret" } });
  assert.deepEqual(runtimePiArgs(profile), [
    "--thinking", "low", "--tools", "read,bash", "--provider", "test-provider", "--model", "test-model",
  ]);
  assert.throws(() => validateRuntimeSecrets({ secretFiles: { "../token": "secret" } }), /filename/);
  assert.throws(() => validateRuntimeProfile({ readOnlyDirectories: ["relative"] }), /absolute/);
});

test("PiRpc rejects commands before it is started", async () => {
  const pi = new PiRpc({ cwd: process.cwd(), agentDir: "/tmp/pi-ship-test-agent" });
  await assert.rejects(pi.send({ type: "get_state" }), /not running/);
});

test("PiRpc returns correlated RPC response data", async () => {
  const pi = new PiRpc({ cwd: process.cwd(), agentDir: "/tmp/pi-ship-test-agent" });
  const internals = pi as unknown as {
    child: { stdin: { write: (line: string, callback: (error?: Error) => void) => void } };
    handleLine: (line: string) => void;
  };
  internals.child = {
    stdin: {
      write(line, callback) {
        const command = JSON.parse(line) as { id: string; type: string };
        callback();
        queueMicrotask(() => internals.handleLine(JSON.stringify({
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          data: { sessionId: "session-1" },
        })));
      },
    },
  };

  const response = await pi.send({ type: "get_state" });
  assert.equal(response.command, "get_state");
  assert.equal(response.data.sessionId, "session-1");
});

test("PiRpc convenience methods expose response data and errors", async () => {
  const pi = new PiRpc({ cwd: process.cwd(), agentDir: "/tmp/pi-ship-test-agent" });
  const internals = pi as unknown as {
    child: { stdin: { write: (line: string, callback: (error?: Error) => void) => void } };
    handleLine: (line: string) => void;
  };
  internals.child = {
    stdin: {
      write(line, callback) {
        const command = JSON.parse(line) as { id: string; type: string };
        callback();
        const result = command.type === "get_commands"
          ? { success: true, data: { commands: [{ name: "fix", source: "prompt", sourceInfo: {} }] } }
          : { success: false, error: "cannot compact" };
        queueMicrotask(() => internals.handleLine(JSON.stringify({
          id: command.id,
          type: "response",
          command: command.type,
          ...result,
        })));
      },
    },
  };

  assert.deepEqual(await pi.getCommands(), [{ name: "fix", source: "prompt", sourceInfo: {} }]);
  await assert.rejects(pi.compact(), /cannot compact/);
});
