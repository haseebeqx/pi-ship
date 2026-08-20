# CLI reference

[Back to README](../README.md) · [Installation](installation.md)

Use `npx pi-ship <command>`. If installed globally, replace `npx pi-ship` with `pi-ship`.

## Commands

| Command | Purpose | Usage |
| --- | --- | --- |
| `deploy` | Install Pi Ship on a server and save the server locally | `npx pi-ship deploy --server <user@host> --name <name> [--default] [options]` |
| `pi` | Open an on-demand Pi session or invoke the remote Pi CLI | `npx pi-ship pi [--server <name-or-user@host>] [--certificate <path>] [-- <pi-args...>]` |
| `channel` | Add, replace, reconfigure, or remove a messaging provider | `npx pi-ship channel [--server <name-or-user@host>] [options]` |
| `config` | Change server-wide defaults | `npx pi-ship config [--server <name-or-user@host>] --session-mode <ephemeral|persistent>` |
| `update` | Update the remote Pi Ship runtime when the local package is newer | `npx pi-ship update [--server <name-or-user@host>] [--certificate <path>]` |
| `update-pi` | Update Pi independently of the Pi Ship runtime | `npx pi-ship update-pi [--server <name-or-user@host>] [--certificate <path>] [--version <semver>]` |
| `status` | Show runtime versions, mode, and service status | `npx pi-ship status [--server <name-or-user@host>] [--certificate <path>]` |
| `logs` | Follow the latest 100 persistent-service log entries | `npx pi-ship logs [--server <name-or-user@host>] [--certificate <path>]` |
| `help` | Show built-in CLI help | `npx pi-ship help` (also `--help` or `-h`) |

## Options

| Command | Option | Value | Required | Description |
| --- | --- | --- | --- | --- |
| `deploy` | `--server` | `<user@host>` | Yes | SSH destination. |
| `deploy` | `--name` | `<name>` | Yes | Saved server name: 1–32 letters, numbers, underscores, or hyphens, starting with a letter or number. Interactive default: `my-pi`. |
| `deploy` | `--certificate` | `<path>` | No | SSH identity file. Supports `~` and `~/...`; saved with the named server. |
| `deploy` | `--default` | — | No | Make this saved server the default. The first saved server becomes the default automatically. |
| `deploy` | `--channel` | `telegram`, `slack`, `none`, or `connect` | No | Messaging mode. `none` (the default) and its alias `connect` use on-demand mode. |
| `deploy` | `--session-mode` | `ephemeral` or `persistent` | No | Default for argument-free interactive sessions. Defaults to `ephemeral`. |
| `deploy` | `--telegram-bot-token` | `<token>` | For Telegram | Telegram bot token. Falls back to `PI_SHIP_TELEGRAM_TOKEN`. |
| `deploy` | `--slack-bot-token` | `<xoxb-token>` | For Slack | Slack bot token. Falls back to `PI_SHIP_SLACK_BOT_TOKEN`. |
| `deploy` | `--slack-app-token` | `<xapp-token>` | For Slack | Slack Socket Mode app token. Falls back to `PI_SHIP_SLACK_APP_TOKEN`. |
| `deploy` | `--runtime-config` | `<json-file>` | No | Generic non-secret `RuntimeProfile` JSON. Prefer the typed `deploy()` API. |
| `deploy` | `--runtime-secrets` | `<json-file>` | No | Generic `RuntimeSecrets` JSON; only the path, never its contents, is placed on the command line. |
| `pi` | `--server` | `<name-or-user@host>` | No | A saved server name or direct SSH destination. Falls back to `PI_SHIP_SERVER`, then the default. |
| `pi` | `--certificate` | `<path>` | No | Override the saved SSH identity file. |
| `pi` | `--` | `<pi-args...>` | No | Stop parsing Pi Ship options and pass all remaining arguments to Pi, for example `-- install npm:@foo/bar`. |
| `channel` | `--server` | `<name-or-user@host>` | No | A saved server name or direct SSH destination. Falls back to `PI_SHIP_SERVER`, then the default. |
| `channel` | `--certificate` | `<path>` | No | Override the saved SSH identity file. |
| `channel` | `--channel` | `telegram`, `slack`, `none`, or `connect` | Yes for non-interactive use | Select a provider; `none` and `connect` disable persistent messaging. Omit in a terminal to use the menu. |
| `channel` | `--telegram-bot-token` | `<token>` | For Telegram | Telegram bot token. Falls back to `PI_SHIP_TELEGRAM_TOKEN`. |
| `channel` | `--slack-bot-token` | `<xoxb-token>` | For Slack | Slack bot token. Falls back to `PI_SHIP_SLACK_BOT_TOKEN`. |
| `channel` | `--slack-app-token` | `<xapp-token>` | For Slack | Slack Socket Mode app token. Falls back to `PI_SHIP_SLACK_APP_TOKEN`. |
| `config` | `--server` | `<name-or-user@host>` | No | Server to configure. Falls back to `PI_SHIP_SERVER`, then the default. |
| `config` | `--certificate` | `<path>` | No | Override the saved SSH identity file. |
| `config` | `--session-mode` | `ephemeral` or `persistent` | Yes for non-interactive use | Set the server-wide default for argument-free interactive sessions. |
| `update` | `--server` | `<name-or-user@host>` | No | A saved server name or direct SSH destination. Falls back to `PI_SHIP_SERVER`, then the default. |
| `update` | `--certificate` | `<path>` | No | Override the saved SSH identity file. |
| `update-pi` | `--server` | `<name-or-user@host>` | No | A saved server name or direct SSH destination. Falls back to `PI_SHIP_SERVER`, then the default. |
| `update-pi` | `--certificate` | `<path>` | No | Override the saved SSH identity file. |
| `update-pi` | `--version` | `<semver>` | No | Install a specific newer Pi version; defaults to the latest npm release. |
| `status` | `--server` | `<name-or-user@host>` | No | A saved server name or direct SSH destination. Falls back to `PI_SHIP_SERVER`, then the default. |
| `status` | `--certificate` | `<path>` | No | Override the saved SSH identity file. |
| `logs` | `--server` | `<name-or-user@host>` | No | A saved server name or direct SSH destination. Falls back to `PI_SHIP_SERVER`, then the default. |
| `logs` | `--certificate` | `<path>` | No | Override the saved SSH identity file. |

Missing required values are requested when running in an interactive terminal. In non-interactive environments, supply them as options or, for credentials, through the listed environment variables. Options cannot be repeated.

## Command behavior

`channel` shows an interactive menu for adding, replacing, reconfiguring, or removing Telegram and Slack. Reconfiguring resets the sender allowlist and prints a new one-time pairing code. To automate it, pass `--channel telegram`, `--channel slack`, or `--channel none` together with the applicable credentials. Provider changes are applied atomically; if the new persistent provider cannot start, Pi Ship restores the previous configuration and service.

`pi` with no Pi arguments uses the server's interactive session mode. The default is `ephemeral`, which starts a fresh, unsaved Pi TUI. Set it to `persistent` with `pi-ship config --session-mode persistent`; future argument-free connections save sessions. Explicit arguments after `--` are passed directly to Pi and determine Pi's session behavior.

When Pi prints `pi --session <id>` after a remote persistent session, resume it through Pi Ship with `pi-ship pi -- --session <id> --approve`.

`status` reports the Pi Ship and Pi versions and whether the runtime is persistent or on demand.

`update` compares the installed version with the local `pi-ship` package and uploads only when the local version is newer.

`update-pi` updates the remote Pi binary independently. Pass `--version <semver>` to install a specific newer version. Persistent services are restarted and automatically rolled back if the updated Pi fails to start. Configuration, credentials, workspace data, and agent state are preserved.
