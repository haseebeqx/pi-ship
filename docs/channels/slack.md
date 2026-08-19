# Slack

[Back to README](../../README.md) · [Messaging behavior and commands](../messaging.md)

Slack uses outbound Socket Mode, so it does not require a public port, webhook, TLS certificate, or reverse proxy.

## Create the Slack app

1. Create a Slack app and enable **Socket Mode**.
2. Create an app-level token (`xapp-`) with `connections:write`.
3. Add these bot scopes under **OAuth & Permissions**:
   - `app_mentions:read`
   - `chat:write`
   - `im:history`
   - `files:read`
   - `reactions:read`
4. Subscribe to the `app_mention`, `message.im`, and `reaction_added` bot events.
5. Install the app to the workspace.

## Deploy

```bash
npx pi-ship deploy \
  --server ubuntu@your-server \
  --certificate ~/.ssh/server.pem \
  --name my-pi \
  --channel slack \
  --slack-bot-token "$SLACK_BOT_TOKEN" \
  --slack-app-token "$SLACK_APP_TOKEN"
```

The bot token must begin with `xoxb-` and the Socket Mode app token with `xapp-`. Tokens can instead be supplied through `PI_SHIP_SLACK_BOT_TOKEN` and `PI_SHIP_SLACK_APP_TOKEN`.

Before using the channel, connect with `pi-ship pi` and authenticate a model provider using Pi's `/login` command.

## Pair an account

Deployment prints a one-time pairing code. Send `/pair CODE` to the app in a **direct message**; the code is never accepted in a public channel. After pairing, only that Slack user can invoke Pi through direct messages or channel mentions. Channel replies use threads.

See [Messaging channels](../messaging.md) for conversation isolation, attachments, channel commands, and proactive delivery.
