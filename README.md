# Pi Ship

Deploy an always-running [Pi](https://pi.dev) to any SSH-accessible Linux server and communicate with it through Telegram or Slack. Users do not configure Node.js, npm, public ports, TLS, process supervisors, or webhooks.

Responses stream in real time by creating provider messages and updating them as Pi emits text. Long responses continue in additional messages instead of discarding earlier output. Provider adapters own rate limiting and platform-specific rendering. Telegram also keeps its typing indicator active while Pi is working.

> Early development: review the installer before using it on a production server.

## Quick start

Requires Node.js 22.19 or newer on your local machine, plus SSH access to an Ubuntu or Debian server whose user has passwordless `sudo`.

### Interactive setup (recommended)

```bash
npx --yes pi-ship@latest deploy
```

**That is the only command you need.** Pi Ship interactively asks for every required option, offers sensible defaults, and hides credentials as you type them. Nothing needs to be installed globally.

If SSH requires an identity file, include the optional certificate argument and Pi Ship will ask for everything else:

```bash
npx --yes pi-ship@latest deploy --certificate ~/.ssh/server.pem
```

### Non-interactive setup

For automation, provide every option explicitly:

```bash
npx --yes pi-ship@latest deploy \
  --server ubuntu@your-server \
  --certificate ~/.ssh/server.pem \
  --name my-pi \
  --provider anthropic \
  --model-api-key "$ANTHROPIC_API_KEY" \
  --channel telegram \
  --telegram-bot-token "$TELEGRAM_BOT_TOKEN"
```

A certificate supplied during deployment is saved with the named server for later commands. API keys and bot tokens can also be supplied through `PI_SHIP_MODEL_API_KEY`, `PI_SHIP_TELEGRAM_TOKEN`, `PI_SHIP_SLACK_BOT_TOKEN`, and `PI_SHIP_SLACK_APP_TOKEN`. Be aware that secrets passed directly on the command line may be visible to other local processes while the command runs.

After deployment, send the displayed pairing command to the Telegram bot:

```text
/pair ABCDEF1234
```

Only paired private Telegram accounts are allowed to send messages.

### Slack

Create a Slack app, enable **Socket Mode**, and create an app-level token (`xapp-`) with `connections:write`. Add these bot scopes under OAuth & Permissions:

- `app_mentions:read`
- `chat:write`
- `im:history`

Subscribe to the `app_mention` and `message.im` bot events, install the app to the workspace, then deploy:

```bash
npx --yes pi-ship@latest deploy \
  --server ubuntu@your-server \
  --certificate ~/.ssh/server.pem \
  --name my-pi \
  --provider anthropic \
  --model-api-key "$ANTHROPIC_API_KEY" \
  --channel slack \
  --slack-bot-token "$SLACK_BOT_TOKEN" \
  --slack-app-token "$SLACK_APP_TOKEN"
```

The bot token must begin with `xoxb-` and the Socket Mode app token with `xapp-`. Deployment prints a one-time pairing code. Send `/pair CODE` to the app in a **direct message**; the code is never accepted in a public channel. After pairing, only that Slack user can invoke Pi through direct messages or channel mentions. Channel replies use threads.

## Commands

```bash
npx --yes pi-ship@latest deploy --server user@server --name my-pi --provider anthropic --model-api-key <key> --channel telegram --telegram-bot-token <token> [--certificate <path>]
npx --yes pi-ship@latest status --server my-pi
npx --yes pi-ship@latest update --server my-pi
npx --yes pi-ship@latest logs --server my-pi
```

If installed globally, the same commands are available as `pi-ship`. Required options that are omitted are requested interactively. In non-interactive environments, supply them as flags or credential environment variables.

`status` reports the runtime version recorded on the server. `update` compares that version with the version of the local `pi-ship` package, and only uploads, installs, and restarts the runtime when the local version is newer. Configuration, credentials, workspace data, and agent state are preserved.

## Security conventions

- No public Pi service port
- Telegram uses outbound long polling; Slack uses outbound Socket Mode
- Dedicated, unprivileged `pi-ship` user
- Hardened systemd service
- Credentials stored in a root-owned, group-readable file with mode `0640`
- One-time, DM-only pairing codes and sender allowlists for Telegram and Slack
- Pinned Node.js download verified against the official checksum
- Pi process automatically restarted after failure or reboot

Pi plugins execute arbitrary code and can access the Pi user's workspace and credentials. Only install plugins you trust. The process does not run as root, but this is not a complete sandbox.

## Development

Install dependencies and run the full local verification suite:

```bash
npm install
npm run check
npm test
npm run build
```

The tests use mocked Telegram and Slack transports, so they do not require API keys, bot tokens, or a server. To run one test file while developing:

```bash
node --import tsx --test test/telegram.test.ts
```

To exercise the CLI directly from the TypeScript source without installing it globally, pass arguments after `--`:

```bash
npm run dev -- --help
npm run dev -- status --server my-pi
```

For an end-to-end deployment test, use a disposable Ubuntu or Debian server. Build first because deployment packages the compiled `dist` directory, then run the development CLI with the same options as the published command:

```bash
npm run build
npm run dev -- deploy \
  --server ubuntu@your-test-server \
  --certificate ~/.ssh/test-server.pem \
  --name dev-pi \
  --provider anthropic \
  --model-api-key "$ANTHROPIC_API_KEY" \
  --channel telegram \
  --telegram-bot-token "$TELEGRAM_BOT_TOKEN"

npm run dev -- status --server dev-pi
npm run dev -- logs --server dev-pi
```

The remote test performs a real system-level installation and requires passwordless `sudo`. Rebuild after source changes. To test the `update` path, increase the semver version in `package.json`; updates are intentionally skipped unless the local version is newer than the installed version.

Communication providers implement `CommunicationProvider` in `src/channels/types.ts`. `openResponse()` is the streaming boundary: providers receive ordered text deltas and can create/edit messages using their native APIs. Providers without realtime updates automatically buffer and send the final response. Telegram and Slack both use rate-limited message edits; the agent runtime remains independent of either API.

## Publishing

The package is prepared automatically before publishing: `prepublishOnly` runs type checks and tests, while `prepack` builds `dist`. To inspect exactly what npm will upload:

```bash
npm pack --dry-run
```

When ready, authenticate with npm and run `npm publish`. The unscoped `pi-ship` package name is currently available; after publishing, the quick-start command above will work.
