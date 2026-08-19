# TypeScript and JavaScript API

[Back to README](../README.md)

Pi Ship can be used as an ESM library from Node.js 22.19 or newer. TypeScript declarations are included.

```bash
npm install pi-ship
```

## Deploy and connect

```typescript
import { connect, deploy } from "pi-ship";

await deploy({
  server: "ubuntu@example.com",
  certificate: "~/.ssh/server.pem",
  name: "my-pi",
  channel: "none",
});

await connect({
  piArgs: ["--no-session"], // Uses the saved default server.
});
```

Messaging credentials are represented by a discriminated union, so TypeScript requires the credentials appropriate to the selected channel:

```typescript
await deploy({
  server: "ubuntu@example.com",
  name: "team-pi",
  channel: "telegram",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
});
```

The package also exports `configureChannel`, `update`, `updatePi`, `status`, and `logs`. JavaScript uses the same API without type annotations.

Deployments can accept generic runtime settings. See [Runtime profiles and secrets](runtime-profiles.md).

## Local Pi RPC

For direct access to Pi's JSONL RPC process, use `PiRpc`:

```typescript
import { PiRpc } from "pi-ship";

const pi = new PiRpc({
  cwd: process.cwd(),
  agentDir: "/tmp/my-pi-agent",
});

await pi.start();
const unsubscribe = pi.onEvent((event) => console.log(event));
const state = await pi.getState();
await pi.setThinkingLevel("high");
await pi.prompt("List the files in this project");
console.log(await pi.getSessionStats());
unsubscribe();
await pi.stop();
```

`PiRpc` exposes Pi's RPC controls for aborting, steering and follow-ups, sessions, models, thinking levels, compaction, statistics, naming, command discovery, images, and direct bash execution. `onEvent()` receives the complete event stream, including tool execution events. `send()` accepts any typed Pi RPC command and returns its correlated response, including `data`, for lower-level access.

`PiRpc` runs Pi locally in a child process.

## Reusable session runtime

Gateways and other applications can use `SessionManager` without adopting Pi Ship's Telegram or Slack message types. Identities may be any application value; a `key` function defines their stable persistent-session identity.

```typescript
import { SessionManager } from "pi-ship";

type Identity = { tenant: string; conversation: string };
const sessions = new SessionManager<Identity>({
  cwd: process.cwd(),
  agentDir: "/tmp/my-pi-agent",
  key: ({ tenant, conversation }) => `${tenant}:${conversation}`,
  idleTimeoutMs: 10 * 60_000,
  maxSessions: 100,
  maxConcurrentSessions: 10,
  maxQueueSizePerSession: 20,
  maxTotalQueueSize: 500,
});

const identity = { tenant: "acme", conversation: "support-42" };
const unsubscribe = sessions.subscribe(identity, (event) => deliver(event));
await sessions.prompt(identity, "Review this repository");
await sessions.steer(identity, "Focus on the public API");
await sessions.followUp(identity, "Now add tests");
await sessions.abort(identity);
unsubscribe();
await sessions.stop();
```

`run(identity, task)` provides FIFO ordering per identity while allowing work for other identities to proceed concurrently. RPC processes are created lazily, continue from a stable hashed session directory after failure or eviction, and are evicted when idle. `abort`, `steer`, and `followUp` bypass the work queue so they can control an active request. `onEvent` receives lifecycle, task, fatal, and wrapped Pi RPC events.

A custom `createSession` factory can supply another `SessionRpc` implementation. Its `SessionFactoryContext` contains only generic identity, storage, and lifecycle concerns, leaving delivery entirely to the application.

## Remote Pi RPC

Use `connectRpc()` for the same programmable API on a server deployed by Pi Ship:

```typescript
import { connectRpc } from "pi-ship";

const pi = await connectRpc({
  server: "my-pi",
  sessionKey: "telegram:123",
});

const unsubscribe = pi.onEvent((event) => console.log(event));
await pi.prompt("List the files in the remote workspace");
unsubscribe();
await pi.close();
```

`sessionKey` selects an isolated persistent remote session; reconnecting with the same key continues it. The key is hashed before it is used as a remote directory name. `server` accepts either a saved Pi Ship name or an SSH target. When omitted, `PI_SHIP_SERVER` or the saved default is used. `certificate` can override the saved SSH identity file. `connect()` remains the interactive terminal API.
