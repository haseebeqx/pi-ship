# Installation and configuration

[Back to README](../README.md)

## Requirements

Your local machine needs:

- Node.js 22.19 or newer
- OpenSSH (`ssh` and `scp`)
- `tar`

The remote server must:

- Run Ubuntu or Debian on x86-64 or ARM64
- Be reachable over SSH
- Use either a root login or an account with passwordless `sudo`

## Interactive setup (recommended)

```bash
npx pi-ship deploy
```

Pi Ship asks for the server details, optionally lets you enter an SSH identity file, and then offers Telegram, Slack, or no messaging provider. None is the default and installs in on-demand mode without leaving an agent process running. The first deployed server becomes the default, so start Pi with:

```bash
npx pi-ship pi
```

This opens a fresh, ephemeral Pi terminal session on the server. Nothing needs to be installed globally. Use Pi's `/login` command to authenticate any supported provider, then select a model with `/model` or Ctrl+L. Authentication is saved on the server for later sessions.

To save interactive sessions by default on this server, run:

```bash
npx pi-ship config --session-mode persistent
```

Change it back with `--session-mode ephemeral`. You can also select the initial default during deployment with `pi-ship deploy --session-mode persistent`. When remote Pi prints a `pi --session <id>` resume hint, use `pi-ship pi -- --session <id> --approve` to resume through Pi Ship.

If you leave the identity file blank, SSH uses your agent or default keys and can prompt for the server account's password normally. An encrypted identity file can likewise prompt for its passphrase. Because deployment opens several SSH/SCP connections, you may be prompted more than once unless an SSH agent caches the credential.

You can provide the identity file up front and let Pi Ship ask for everything else:

```bash
npx pi-ship deploy --certificate ~/.ssh/server.pem
```

> Unless you connect as root, the server account must have passwordless `sudo`. SSH login passwords and key passphrases are supported, but Pi Ship's remote installer does not accept a `sudo` password.

## Non-interactive setup

For automation, provide the server options explicitly. This example uses the default on-demand mode:

```bash
npx pi-ship deploy \
  --server ubuntu@your-server \
  --certificate ~/.ssh/server.pem \
  --name my-pi \
  --session-mode persistent

npx pi-ship pi --server my-pi
```

To run Pi continuously, add credentials for [Telegram](channels/telegram.md) or [Slack](channels/slack.md). For example:

```bash
npx pi-ship deploy \
  --server ubuntu@your-server \
  --certificate ~/.ssh/server.pem \
  --name my-pi \
  --channel telegram \
  --telegram-bot-token "$TELEGRAM_BOT_TOKEN"
```

Pi Ship does not restrict or configure Pi's model providers. Before using a persistent channel, run `pi-ship pi` and authenticate through Pi's `/login` command.

## Saved servers and credentials

A certificate supplied during deployment is saved with the named server for later commands. The first deployed server becomes the default automatically; pass `--default` on a later deployment to replace it.

For any remote command, server selection uses this precedence:

1. An explicit `--server`
2. `PI_SHIP_SERVER`
3. The saved default

List locally saved servers with:

```bash
npx pi-ship list
```

Remove a saved connection without changing the remote installation:

```bash
npx pi-ship remove --server my-pi
```

To also uninstall Pi Ship and permanently delete its remote configuration, credentials, workspace, agent state, and system user, pass `--uninstall`:

```bash
npx pi-ship remove --server my-pi --uninstall
```

Bot tokens can be supplied through `PI_SHIP_TELEGRAM_TOKEN`, `PI_SHIP_SLACK_BOT_TOKEN`, and `PI_SHIP_SLACK_APP_TOKEN`. Secrets passed directly on the command line may be visible to other local processes while the command runs.

See the [CLI reference](cli-reference.md) for every command and option.

## Updating an installation

Update the Pi Ship runtime using the locally installed package:

```bash
npx pi-ship update --server my-pi
```

Update Pi independently:

```bash
npx pi-ship update-pi --server my-pi
```

Persistent services are restarted and automatically rolled back if an update fails its health check. Configuration, credentials, workspace data, and agent state are preserved.
