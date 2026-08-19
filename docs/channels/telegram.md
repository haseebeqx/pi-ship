# Telegram

[Back to README](../../README.md) · [Messaging behavior and commands](../messaging.md)

Telegram uses outbound long polling, so it does not require a public port, webhook, TLS certificate, or reverse proxy.

## Deploy

Create a Telegram bot and provide its token during deployment:

```bash
npx pi-ship deploy \
  --server ubuntu@your-server \
  --certificate ~/.ssh/server.pem \
  --name my-pi \
  --channel telegram \
  --telegram-bot-token "$TELEGRAM_BOT_TOKEN"
```

The token can instead be supplied through `PI_SHIP_TELEGRAM_TOKEN`. Secrets passed on the command line may be visible to other local processes while the command runs.

Before using the channel, connect with `pi-ship pi` and authenticate a model provider using Pi's `/login` command.

## Pair an account

Deployment displays a one-time pairing command. Send it to the Telegram bot in a private message:

```text
/pair ABCDEF1234
```

Only paired private Telegram accounts are allowed to send messages.

See [Messaging channels](../messaging.md) for conversation isolation, attachments, channel commands, and proactive delivery.
