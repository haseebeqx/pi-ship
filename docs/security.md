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

## Project directory access

Pi always runs as the dedicated `pi-ship` user, including when `pi-ship pi --cwd /path/to/project` selects a project owned by another server user. `--cwd` changes only the working directory; it does not change the process identity or bypass filesystem permissions. The `pi-ship` user must have execute permission on parent directories and the required read or write permission on the project. Git may also reject a repository owned by another user as having dubious ownership.

Running Pi as the SSH/login user is not currently supported. Prefer a project cloned under `/var/lib/pi-ship/workspace` or grant narrowly scoped access to an individual project. Avoid granting `pi-ship` access to an entire home directory.

## Trust boundary

Pi plugins execute arbitrary code and can access the Pi user's workspace and credentials. Only install plugins you trust. The process does not run as root, but this is not a complete sandbox.

Runtime secret handling is documented in [Runtime profiles and secrets](runtime-profiles.md).
