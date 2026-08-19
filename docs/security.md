# Security

[Back to README](../README.md)

## Conventions

- No public Pi service port
- Telegram uses outbound long polling; Slack uses outbound Socket Mode
- Dedicated, unprivileged `pi-ship` user
- Hardened systemd service
- Credentials stored in a root-owned, group-readable file with mode `0640`
- One-time, DM-only pairing codes and sender allowlists for Telegram and Slack
- Pinned, shrinkwrapped production dependencies
- Node.js downloads verified against the official checksum
- Communication-provider mode reports ready only after Pi and its transports connect
- Automatic service restart after failure or reboot
- Serialized deployment updates with readiness-checked rollback
- On-demand mode runs Pi only for the lifetime of `pi-ship pi`

## Trust boundary

Pi plugins execute arbitrary code and can access the Pi user's workspace and credentials. Only install plugins you trust. The process does not run as root, but this is not a complete sandbox.

Runtime secret handling is documented in [Runtime profiles and secrets](runtime-profiles.md).
