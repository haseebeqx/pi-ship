# Pi Ship

Deploy an always-running [Pi](https://pi.dev) to any SSH-accessible Linux server and communicate with it through Telegram or Slack. Users do not configure Node.js, npm, public ports, TLS, process supervisors, or webhooks.

Responses stream in real time by creating one provider message and updating it as Pi emits text. Provider adapters own rate limiting and platform-specific rendering. Telegram also keeps its typing indicator active while Pi is working.

> Early development: review the installer before using it on a production server.

## Quick start

Requires Node.js 22.19 or newer on your local machine, plus SSH access to an Ubuntu or Debian server whose user has passwordless `sudo`.

```bash
npx --yes pi-ship@latest deploy ubuntu@your-server --name my-pi
```

Nothing needs to be installed globally. The setup asks for a model API key and Telegram bot token without echoing them. For automation, use `PI_SHIP_MODEL_API_KEY` and `PI_SHIP_TELEGRAM_TOKEN`.

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
npx --yes pi-ship@latest deploy ubuntu@your-server --name my-pi --channel slack
```

Enter the bot token (`xoxb-`) and app token (`xapp-`) when prompted. For automation, use `PI_SHIP_SLACK_BOT_TOKEN` and `PI_SHIP_SLACK_APP_TOKEN`. Pi replies to direct messages and to mentions in channels, using threads for channel conversations.

## Commands

```bash
npx --yes pi-ship@latest deploy user@server
npx --yes pi-ship@latest status my-pi
npx --yes pi-ship@latest update my-pi
npx --yes pi-ship@latest logs my-pi
```

If installed globally, the same commands are available as `pi-ship`.

`status` reports the runtime version recorded on the server. `update` compares that version with the version of the local `pi-ship` package, and only uploads, installs, and restarts the runtime when the local version is newer. Configuration, credentials, workspace data, and agent state are preserved.

## Security conventions

- No public Pi service port
- Telegram uses outbound long polling; Slack uses outbound Socket Mode
- Dedicated, unprivileged `pi-ship` user
- Hardened systemd service
- Credentials stored in a root-owned, group-readable file with mode `0640`
- One-time Telegram pairing code and sender allowlist
- Pinned Node.js download verified against the official checksum
- Pi process automatically restarted after failure or reboot

Pi plugins execute arbitrary code and can access the Pi user's workspace and credentials. Only install plugins you trust. The process does not run as root, but this is not a complete sandbox.

## Development

```bash
npm install
npm run check
npm test
npm run build
```

Communication providers implement `CommunicationProvider` in `src/channels/types.ts`. `openResponse()` is the streaming boundary: providers receive ordered text deltas and can create/edit messages using their native APIs. Providers without realtime updates automatically buffer and send the final response. Telegram and Slack both use rate-limited message edits; the agent runtime remains independent of either API.

## Publishing

The package is prepared automatically before publishing: `prepublishOnly` runs type checks and tests, while `prepack` builds `dist`. To inspect exactly what npm will upload:

```bash
npm pack --dry-run
```

When ready, authenticate with npm and run `npm publish`. The unscoped `pi-ship` package name is currently available; after publishing, the quick-start command above will work.
