# Messaging channels

[Back to README](../README.md)

With Telegram or Slack configured, Pi Ship keeps Pi running continuously. The transports are built into Pi Ship rather than loaded as Pi plugins, so they do not modify Pi's prompt or tools.

Responses stream in real time through rate-limited message edits. Long responses continue in additional messages rather than discarding earlier output. Transient API failures are retried, and final delivery state survives restarts.

## Conversations

Each Telegram chat, Slack direct-message conversation, and Slack thread has its own persistent Pi session. Messages in one conversation are processed in order, while separate conversations can run concurrently without sharing model context.

Images are passed to vision-capable models. Documents and voice/audio messages are saved under the workspace's protected `.pi-ship/uploads` directory, and their paths are included in the prompt so Pi and installed tools can inspect them. Reply metadata and quoted text are preserved as prompt context.

## Commands

- `/stop` or `/cancel` — abort active work immediately
- `/new` — start a fresh session for the conversation
- `/model` and `/model provider/model-id` — inspect or select the model
- `/models` — list configured models
- `/thinking off|minimal|low|medium|high|xhigh|max` — set reasoning effort
- `/session` — show current session state
- `/commands` — list Pi extension, prompt-template, and skill commands
- `/help` — show channel commands

## Proactive messages

Trusted local services and Pi extensions can send messages by atomically writing a JSON file to `<workspace>/.pi-ship/outbox`:

```json
{"provider":"telegram","conversationId":"123456","text":"The scheduled task finished."}
```

The runtime claims queued files, retries transient provider failures, and records pending/delivered state under the agent directory so interrupted final deliveries can be retried after restart. Delivery is at-least-once; provider outages around acknowledgement can produce a duplicate.

## Provider setup

- [Telegram](channels/telegram.md)
- [Slack](channels/slack.md)

Use `pi-ship channel` to add, replace, reconfigure, or remove a provider. Reconfiguring resets the sender allowlist and prints a new one-time pairing code. Provider changes are atomic; Pi Ship restores the previous configuration and service if a new provider cannot start.
