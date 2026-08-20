# Changelog

All notable changes to this project are documented in this file.

## [0.2.1] - 2026-08-20

### Added

- Server-wide defaults for ephemeral or persistent interactive Pi sessions.
- Remote working-directory selection for `pi` sessions through `--cwd`.
- Commands to list saved servers and remove local server entries, with optional remote uninstallation.

### Changed

- Expanded CLI help and documentation for session defaults, working directories, server selection, and removal.
- Improved remote installation and public API support for the new server-management behavior.

## [0.2.0] - 2026-08-19

This first changelog entry summarizes the work from commit [`1519a03`](https://github.com/haseebeqx/pi-ship/commit/1519a034606b09c4d7fb8660d49e27ac099d4843) through `0b62dff`.

### Added

- A public JavaScript and TypeScript library API alongside the CLI.
- Conversation-scoped Pi sessions and reusable session orchestration with persistence, queueing, limits, recovery, lifecycle events, and runtime controls.
- Expanded typed RPC support for messages, images, sessions, models, thinking levels, compaction, retries, shell commands, and HTML export.
- Programmable remote RPC connections over SSH with isolated persistent sessions.
- Telegram and Slack attachments, reply context, reactions, commands, progress updates, Markdown adaptation, proactive delivery, retry handling, and restart recovery.
- Implicit server selection and configurable default servers.
- Runtime profiles for environment configuration, secret files, directories, Pi arguments, tool allowlists, model defaults, resource limits, and session limits.
- Comprehensive API, inventory, messaging, RPC, session, and runtime-profile test coverage.

### Changed

- Refactored CLI commands and runtime session handling around reusable public modules.
- Reorganized the project documentation into focused installation, CLI, API, messaging, channel, security, development, runtime-profile, and release guides.
- Improved package metadata and npm release automation.

[0.2.1]: https://github.com/haseebeqx/pi-ship/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/haseebeqx/pi-ship/releases/tag/v0.2.0
