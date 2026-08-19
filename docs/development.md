# Development

[Back to README](../README.md)

## Local verification

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

## Run the source CLI

Pass arguments after `--` to exercise the CLI directly from TypeScript without installing it globally:

```bash
npm run dev -- --help
npm run dev -- status --server my-pi
```

## End-to-end deployment

Use a disposable Ubuntu or Debian server. Build first because deployment packages the compiled `dist` directory, then run the development CLI with the same options as the published command:

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

## Communication providers

Communication providers implement `CommunicationProvider` in `src/channels/types.ts`. `openResponse()` is the streaming boundary: providers receive ordered text deltas and can create or edit messages using their native APIs. Providers without realtime updates automatically buffer and send the final response.

Telegram and Slack both use rate-limited message edits; the agent runtime remains independent of either API.

See [Release process](releasing.md) for publishing instructions.
