# Pi Ship

Deploy [Pi](https://pi.dev) to any SSH-accessible Linux server and connect directly for an on-demand terminal session. Optionally configure Telegram or Slack to keep Pi running continuously. Users do not configure Node.js, npm, public ports, TLS, process supervisors, or webhooks.

Direct sessions stream Pi's interactive terminal over SSH and stop when you disconnect. With a communication provider, responses stream in real time by creating provider messages and updating them as Pi emits text. Long responses continue in additional messages instead of discarding earlier output.

> Early development: review the installer before using it on a production server.

## Features
- **One-command remote deployment** — install Pi, Node.js, configuration, and service management on any supported SSH-accessible server without configuring the server by hand.
- **No exposed service** — Telegram long polling and Slack Socket Mode make outbound connections, so there are no public ports, webhooks, TLS certificates, or reverse proxies to maintain.
- **Messaging without Pi plugins** — Telegram and Slack are built-in transports in Pi Ship, not plugins loaded into the agent. Pi stays unchanged, the transports do not modify its prompt or tools, and you do not have to give a third-party integration plugin access to the agent's workspace and credentials.
- **Direct Pi access** — run `npx pi-ship pi --server <name>` to open Pi's full interactive terminal over SSH, without logging into the server or managing a remote command yourself.
- **On demand or always available** — use a fresh interactive Pi terminal with no idle process, or run a persistent agent through a messaging channel.
- **Real-time native responses** — Pi's output streams into Telegram and Slack as it is generated, with rate-limited edits, message continuation, and Slack thread replies.
- **Stock Pi experience** — use Pi's normal model providers, authentication, models, sessions, tools, and trusted plugins instead of a channel-specific fork or reduced bot interface.
- **Private by default** — a dedicated unprivileged user, one-time DM pairing, sender allowlists, protected credentials, and no root agent process.
- **Safe operations** — health-checked deploys and updates roll back on failure; systemd restarts the persistent runtime after failures and reboots.
- **Independent upgrades** — update Pi Ship or the Pi binary separately without losing configuration, credentials, workspace data, or agent state.

## Quick start

Requires Node.js 22.19 or newer on your local machine, plus SSH access to an Ubuntu or Debian server whose user has passwordless `sudo`.

### Interactive setup (recommended)

```bash
npx pi-ship deploy
```

Pi Ship asks for the server details, optionally lets you enter an SSH identity file, and then offers Telegram, Slack, or no messaging provider. None is the default and installs in on-demand mode without leaving an agent process running. Start Pi after deployment with:

```bash
npx pi-ship pi --server my-pi
```

This opens a fresh, ephemeral Pi terminal session on the server. Nothing needs to be installed globally. Use Pi's `/login` command to authenticate any supported provider, then select a model with `/model` or Ctrl+L. Authentication is saved on the server for later sessions.

If you leave the identity file blank, SSH uses your agent or default keys and can prompt for the server account's password normally. An encrypted identity file can likewise prompt for its passphrase. Because deployment opens several SSH/SCP connections, you may be prompted more than once unless an SSH agent caches the credential.

You can also provide the identity file up front and let Pi Ship ask for everything else:

```bash
npx pi-ship deploy --certificate ~/.ssh/server.pem
```

> The server account must still have passwordless `sudo`. SSH login passwords and key passphrases are supported, but Pi Ship's remote installer does not accept a `sudo` password.

### Non-interactive setup

For automation, provide the server options explicitly. This example uses the default on-demand mode:

```bash
npx pi-ship deploy \
  --server ubuntu@your-server \
  --certificate ~/.ssh/server.pem \
  --name my-pi

npx pi-ship pi --server my-pi
```

To run Pi continuously through a communication provider, add channel credentials:

```bash
npx pi-ship deploy \
  --server ubuntu@your-server \
  --certificate ~/.ssh/server.pem \
  --name my-pi \
  --channel telegram \
  --telegram-bot-token "$TELEGRAM_BOT_TOKEN"
```

A certificate supplied during deployment is saved with the named server for later commands. Bot tokens can also be supplied through `PI_SHIP_TELEGRAM_TOKEN`, `PI_SHIP_SLACK_BOT_TOKEN`, and `PI_SHIP_SLACK_APP_TOKEN`. Be aware that secrets passed directly on the command line may be visible to other local processes while the command runs.

Pi Ship does not restrict or configure Pi's model providers. Before using a persistent Telegram or Slack channel, run `pi-ship pi --server my-pi` and authenticate through Pi's `/login` command.

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
npx pi-ship deploy \
  --server ubuntu@your-server \
  --certificate ~/.ssh/server.pem \
  --name my-pi \
  --channel slack \
  --slack-bot-token "$SLACK_BOT_TOKEN" \
  --slack-app-token "$SLACK_APP_TOKEN"
```

The bot token must begin with `xoxb-` and the Socket Mode app token with `xapp-`. Deployment prints a one-time pairing code. Send `/pair CODE` to the app in a **direct message**; the code is never accepted in a public channel. After pairing, only that Slack user can invoke Pi through direct messages or channel mentions. Channel replies use threads.

## Command reference

Use `npx pi-ship <command>`. If installed globally, replace `npx pi-ship` with `pi-ship`.

| Command | Purpose | Usage |
| --- | --- | --- |
| `deploy` | Install Pi Ship on a server and save the server locally | `npx pi-ship deploy --server <user@host> --name <name> [options]` |
| `pi` | Open an on-demand Pi session or invoke the remote Pi CLI | `npx pi-ship pi --server <name-or-user@host> [--certificate <path>] [-- <pi-args...>]` |
| `channel` | Add, replace, reconfigure, or remove a messaging provider | `npx pi-ship channel --server <name-or-user@host> [options]` |
| `update` | Update the remote Pi Ship runtime when the local package is newer | `npx pi-ship update --server <name-or-user@host> [--certificate <path>]` |
| `update-pi` | Update Pi independently of the Pi Ship runtime | `npx pi-ship update-pi --server <name-or-user@host> [--certificate <path>] [--version <semver>]` |
| `status` | Show runtime versions, mode, and service status | `npx pi-ship status --server <name-or-user@host> [--certificate <path>]` |
| `logs` | Follow the latest 100 persistent-service log entries | `npx pi-ship logs --server <name-or-user@host> [--certificate <path>]` |
| `help` | Show built-in CLI help | `npx pi-ship help` (also `--help` or `-h`) |

### Options

| Command | Option | Value | Required | Description |
| --- | --- | --- | --- | --- |
| `deploy` | `--server` | `<user@host>` | Yes | SSH destination. |
| `deploy` | `--name` | `<name>` | Yes | Saved server name: 1–32 letters, numbers, underscores, or hyphens, starting with a letter or number. Interactive default: `my-pi`. |
| `deploy` | `--certificate` | `<path>` | No | SSH identity file. Supports `~` and `~/...`; saved with the named server. |
| `deploy` | `--channel` | `telegram`, `slack`, `none`, or `connect` | No | Messaging mode. `none` (the default) and its alias `connect` use on-demand mode. |
| `deploy` | `--telegram-bot-token` | `<token>` | For Telegram | Telegram bot token. Falls back to `PI_SHIP_TELEGRAM_TOKEN`. |
| `deploy` | `--slack-bot-token` | `<xoxb-token>` | For Slack | Slack bot token. Falls back to `PI_SHIP_SLACK_BOT_TOKEN`. |
| `deploy` | `--slack-app-token` | `<xapp-token>` | For Slack | Slack Socket Mode app token. Falls back to `PI_SHIP_SLACK_APP_TOKEN`. |
| `pi` | `--server` | `<name-or-user@host>` | Yes | A saved server name or direct SSH destination. |
| `pi` | `--certificate` | `<path>` | No | Override the saved SSH identity file. |
| `pi` | `--` | `<pi-args...>` | No | Stop parsing Pi Ship options and pass all remaining arguments to Pi, for example `-- install npm:@foo/bar`. |
| `channel` | `--server` | `<name-or-user@host>` | Yes | A saved server name or direct SSH destination. |
| `channel` | `--certificate` | `<path>` | No | Override the saved SSH identity file. |
| `channel` | `--channel` | `telegram`, `slack`, `none`, or `connect` | Yes for non-interactive use | Select a provider; `none` and `connect` disable persistent messaging. Omit in a terminal to use the menu. |
| `channel` | `--telegram-bot-token` | `<token>` | For Telegram | Telegram bot token. Falls back to `PI_SHIP_TELEGRAM_TOKEN`. |
| `channel` | `--slack-bot-token` | `<xoxb-token>` | For Slack | Slack bot token. Falls back to `PI_SHIP_SLACK_BOT_TOKEN`. |
| `channel` | `--slack-app-token` | `<xapp-token>` | For Slack | Slack Socket Mode app token. Falls back to `PI_SHIP_SLACK_APP_TOKEN`. |
| `update` | `--server` | `<name-or-user@host>` | Yes | A saved server name or direct SSH destination. |
| `update` | `--certificate` | `<path>` | No | Override the saved SSH identity file. |
| `update-pi` | `--server` | `<name-or-user@host>` | Yes | A saved server name or direct SSH destination. |
| `update-pi` | `--certificate` | `<path>` | No | Override the saved SSH identity file. |
| `update-pi` | `--version` | `<semver>` | No | Install a specific newer Pi version; defaults to the latest npm release. |
| `status` | `--server` | `<name-or-user@host>` | Yes | A saved server name or direct SSH destination. |
| `status` | `--certificate` | `<path>` | No | Override the saved SSH identity file. |
| `logs` | `--server` | `<name-or-user@host>` | Yes | A saved server name or direct SSH destination. |
| `logs` | `--certificate` | `<path>` | No | Override the saved SSH identity file. |

Missing required values are requested when running in an interactive terminal. In non-interactive environments, supply them as options or, for credentials, through the listed environment variables. Options cannot be repeated.

`channel` shows an interactive menu for adding, replacing, reconfiguring, or removing Telegram and Slack. Reconfiguring resets the sender allowlist and prints a new one-time pairing code. To automate it, pass `--channel telegram`, `--channel slack`, or `--channel none` together with the applicable credentials. Provider changes are applied atomically; if the new persistent provider cannot start, Pi Ship restores the previous configuration and service.

`pi` with no Pi arguments streams a fresh, one-off Pi TUI over SSH; no remote Pi process remains after it exits. Arguments after `--` are passed directly to the remote Pi CLI, allowing commands such as `install`, `remove`, and `list`. `status` reports the Pi Ship and Pi versions and whether the runtime is persistent or on demand. `update` compares that version with the local `pi-ship` package and only uploads and installs when the local version is newer. `update-pi` updates the remote Pi binary to the latest release independently of Pi Ship; pass `--version <semver>` to install a specific newer version. Persistent services are restarted and automatically rolled back if the updated Pi fails to start. Configuration, credentials, workspace data, and agent state are preserved.

## Security conventions

- No public Pi service port
- Telegram uses outbound long polling; Slack uses outbound Socket Mode
- Dedicated, unprivileged `pi-ship` user
- Hardened systemd service
- Credentials stored in a root-owned, group-readable file with mode `0640`
- One-time, DM-only pairing codes and sender allowlists for Telegram and Slack
- Pinned, shrinkwrapped production dependencies and a Node.js download verified against the official checksum
- Communication-provider mode reports ready only after Pi and its transports connect, and automatically restarts after failure or reboot
- Serialized deployment updates with readiness-checked rollback
- On-demand mode runs Pi only for the lifetime of `pi-ship pi`

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
  --channel telegram \
  --telegram-bot-token "$TELEGRAM_BOT_TOKEN"

npm run dev -- status --server dev-pi
npm run dev -- logs --server dev-pi
```

The remote test performs a real system-level installation and requires passwordless `sudo`. Rebuild after source changes. To test the `update` path, increase the semver version in `package.json`; updates are intentionally skipped unless the local version is newer than the installed version.

Communication providers implement `CommunicationProvider` in `src/channels/types.ts`. `openResponse()` is the streaming boundary: providers receive ordered text deltas and can create/edit messages using their native APIs. Providers without realtime updates automatically buffer and send the final response. Telegram and Slack both use rate-limited message edits; the agent runtime remains independent of either API.

## Publishing

`npm run verify` type-checks, tests, and builds the project. npm also runs the checks and build through `prepublishOnly` and `prepack`, so a broken package cannot be published accidentally. Inspect the upload before a release with:

```bash
npm pack --dry-run
```

### First publish

The `pi-ship` name is currently unclaimed. The package must exist on npm before npm exposes its trusted-publisher settings, so publish `0.1.0` once from a secure local checkout:

```bash
npm login
npm run verify
npm publish --access public
```

Publishing is an external, irreversible action. Confirm that the repository is clean, the version is correct, and the dry-run contents are expected before running it.

### Trusted publisher setup

After the first publish, open the package settings on npmjs.com and add a **GitHub Actions** trusted publisher with these exact values:

- Organization or user: `haseebeqx`
- Repository: `pi-ship`
- Workflow filename: `publish.yml`
- Environment name: leave blank
- Allowed action: `npm publish`

The workflow at `.github/workflows/publish.yml` uses GitHub's OIDC identity and npm provenance, so it does not need an `NPM_TOKEN` secret. For maximum protection, require two-factor authentication and publishing through a trusted publisher in the package's npm access settings after confirming the workflow works.

### Future releases

Create versions and tags with npm so `package.json` and `npm-shrinkwrap.json` stay synchronized, then publish a GitHub Release for that tag:

```bash
npm version patch # or minor / major
npm run verify
git push origin main --follow-tags
VERSION=$(node -p "require('./package.json').version")
gh release create "v$VERSION" --verify-tag --generate-notes
```

Publishing the GitHub Release triggers `.github/workflows/publish.yml`. The workflow rejects a release whose tag does not exactly match `v<package version>`, runs the package lifecycle checks, and publishes to npm with provenance. CI independently verifies pull requests and pushes on the minimum supported Node.js release and the current Node.js line.
