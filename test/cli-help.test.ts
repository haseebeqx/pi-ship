import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/commands.js";

async function captureHelp(args: string[]): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  try {
    await runCli(args);
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

test("general help explains what each command does", async () => {
  const output = await captureHelp(["--help"]);

  for (const description of [
    "deploy      Install Pi Ship on a server over SSH",
    "pi          Open an interactive session or run the remote Pi CLI",
    "channel     Configure or disable Telegram or Slack messaging",
    "config      Change server-wide interactive session defaults",
    "status      Show versions, operating mode, and service health",
    "logs        Follow logs from the persistent messaging service",
    "update      Update the Pi Ship runtime on a server",
    "update-pi   Update the Pi coding agent separately",
  ]) {
    assert.match(output, new RegExp(description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(output, /pi-ship help <command>/);
});

test("command help shows purpose, usage, and relevant options", async () => {
  const output = await captureHelp(["deploy", "--help"]);

  assert.match(output, /^deploy — Install Pi Ship on a Linux server over SSH/);
  assert.match(output, /Usage:\n  pi-ship deploy \[options\]/);
  assert.match(output, /--channel <telegram\|slack\|none>/);
  assert.match(output, /--session-mode <mode>/);
});

test("pi help documents the remote working directory", async () => {
  const output = await captureHelp(["pi", "--help"]);

  assert.match(output, /--cwd <absolute-server-path>/);
  assert.match(output, /pi-ship pi --cwd \/srv\/my-project/);
});

test("config help documents the server-wide session default", async () => {
  const output = await captureHelp(["config", "--help"]);

  assert.match(output, /^config — Change server-wide Pi Ship defaults/);
  assert.match(output, /--session-mode <ephemeral\|persistent>/);
});

test("help command accepts a command name", async () => {
  const output = await captureHelp(["help", "logs"]);

  assert.match(output, /^logs — Follow the persistent messaging service log/);
  assert.match(output, /pi-ship logs \[--server/);
});
