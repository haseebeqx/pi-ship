# Runtime profiles and secrets

[Back to README](../README.md) · [API](api.md)

Deployments accept a generic runtime profile so downstream gateways and agent products do not require integration-specific Pi Ship fields for each capability.

```typescript
import { deploy } from "pi-ship";

await deploy({
  server: "ubuntu@example.com",
  name: "automation",
  channel: "none",
  runtime: {
    environment: { APP_MODE: "production" },
    configuration: { pollingIntervalMs: 30_000 },
    readOnlyDirectories: ["/srv/reference-data"],
    readWriteDirectories: ["/srv/automation-state"],
    piArgs: ["--thinking", "high"],
    tools: ["read", "write", "bash"],
    model: { provider: "your-provider", id: "your-model-id" },
    resources: {
      memoryMaxBytes: 2_147_483_648,
      tasksMax: 128,
      maxSessions: 50,
    },
  },
  runtimeSecrets: {
    environment: { SERVICE_TOKEN: process.env.SERVICE_TOKEN! },
    secretFiles: { "signing-key.pem": process.env.SIGNING_KEY! },
  },
});
```

## Profile fields

| Field | Purpose |
| --- | --- |
| `environment` | Non-secret environment variables inherited by Pi |
| `configuration` | Arbitrary non-secret JSON application configuration |
| `readOnlyDirectories` | Additional absolute paths exposed read-only by the service sandbox |
| `readWriteDirectories` | Additional absolute paths exposed read-write by the service sandbox |
| `piArgs` | Additional arguments passed to Pi |
| `tools` | Pi built-in tool allowlist |
| `model` | Initial provider and model for sessions without a saved selection |
| `resources` | Service and session resource limits |

Available resource limits are:

| Field | Enforcement |
| --- | --- |
| `memoryMaxBytes` | systemd `MemoryMax` |
| `cpuQuotaPercent` | systemd `CPUQuota` |
| `tasksMax` | systemd `TasksMax` |
| `maxSessions` | Maximum retained session identities |
| `maxConcurrentSessions` | Maximum concurrently running tasks across identities |
| `maxQueueSizePerSession` | Maximum outstanding tasks for one identity |
| `maxTotalQueueSize` | Maximum outstanding tasks across all identities |
| `idleTimeoutMs` | Evict an inactive session after this duration; `0` evicts immediately |

Resource limits are optional. Service limits are enforced by systemd; session limits are enforced by `SessionManager` and otherwise default to unlimited. Idle eviction is disabled when `idleTimeoutMs` is omitted.

## Configuration

Non-secret `configuration` is written outside the workspace and its path is exposed to the runtime as `PI_SHIP_RUNTIME_CONFIG`.

Use `runtime.environment` for public environment values. Filesystem and service resource limits are enforced by the hardened systemd service, while queue and session limits are enforced by `SessionManager`.

The CLI accepts profiles through `deploy --runtime-config <json-file>`, although the typed `deploy()` API is preferred.

## Secrets

Secret environment variables and files are transferred separately. Secret files are installed with restricted permissions under the directory named by `PI_SHIP_SECRET_DIR`.

Secret values are never added to the runtime profile, command arguments, service unit, status output, or progress messages. Secret names—but not values—may be used in validation errors.

Use:

- `runtimeSecrets.environment` for credential environment variables
- `runtimeSecrets.secretFiles` for credential files

The CLI accepts secrets through `deploy --runtime-secrets <json-file>`. Only the file path, never its contents, is placed on the command line. Protect the local JSON file and remove it when it is no longer needed.
