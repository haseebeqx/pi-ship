# Pi Ship

Deploy [Pi](https://pi.dev) to any SSH-accessible Linux server and connect directly for an on-demand terminal session. Optionally configure Telegram or Slack to keep Pi running continuously. Users do not configure Node.js, npm, public ports, TLS, process supervisors, or webhooks.

Direct sessions stream Pi's interactive terminal over SSH and stop when you disconnect. Messaging responses stream in real time and continue in additional messages when necessary.

> Early development: review the installer before using it on a production server.

## Features

- **One-command remote deployment** — install Pi, Node.js, configuration, and service management without configuring the server by hand.
- **No exposed service** — Telegram long polling and Slack Socket Mode require no public ports, webhooks, TLS certificates, or reverse proxies.
- **Direct Pi access** — open Pi's full interactive terminal over SSH with `npx pi-ship pi`.
- **On demand or always available** — use ephemeral terminal sessions or a persistent agent through a messaging channel.
- **Native messaging** — streaming responses, message continuation, Markdown adaptation, attachments, reactions, and live tool status.
- **Stock Pi experience** — use Pi's normal providers, authentication, models, sessions, tools, and trusted plugins.
- **Private by default** — an unprivileged user, one-time DM pairing, sender allowlists, protected credentials, and no root agent process.
- **Safe operations** — persistent deployments and updates use readiness checks and roll back on failure, while systemd handles failures and reboots.
- **Independent upgrades** — update Pi Ship or Pi separately without losing configuration, credentials, workspace data, or agent state.

## Requirements

- Node.js 22.19 or newer, OpenSSH (`ssh` and `scp`), and `tar` on your local machine
- An x86-64 or ARM64 Ubuntu/Debian server reachable over SSH
- A root server account or an account with passwordless `sudo`

## Quick start

Run the interactive deployment:

```bash
npx pi-ship deploy
```

Then open Pi on the default server:

```bash
npx pi-ship pi
```

Use Pi's `/login` command to authenticate a model provider, then select a model with `/model` or <kbd>Ctrl</kbd>+<kbd>L</kbd>.

See [Installation](docs/installation.md) for non-interactive deployment, SSH credentials, server selection, and messaging setup.

## Documentation

- [Installation and configuration](docs/installation.md)
- [CLI reference](docs/cli-reference.md)
- [TypeScript and JavaScript API](docs/api.md)
- [Runtime profiles and secrets](docs/runtime-profiles.md)
- [Messaging behavior and commands](docs/messaging.md)
  - [Telegram setup](docs/channels/telegram.md)
  - [Slack setup](docs/channels/slack.md)
- [Security](docs/security.md)
- [Development](docs/development.md)
- [Release process](docs/releasing.md)

## Library usage

Pi Ship is also an ESM library with TypeScript declarations:

```bash
npm install pi-ship
```

```typescript
import { connect, deploy } from "pi-ship";

await deploy({
  server: "ubuntu@example.com",
  name: "my-pi",
  channel: "none",
});

await connect({ piArgs: ["--no-session"] });
```

See the [API documentation](docs/api.md) for remote RPC access and reusable session management.

## License

[MIT](LICENSE)
