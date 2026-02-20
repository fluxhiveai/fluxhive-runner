# Configuration Reference

All configuration is driven by environment variables. The runner loads `.env` and `.env.local` files from the working directory on startup (via Node.js `process.loadEnvFile`).

## Required Variables

| Variable     | Description                                                        |
| ------------ | ------------------------------------------------------------------ |
| `FLUX_TOKEN` | API token for authenticating with the FluxHive MCP API. Required.  |
| `FLUX_HOST`  | Base URL of the FluxHive server (e.g. `https://app.fluxhive.com`). Required. |

If either is missing, the runner exits with an error immediately.

## Runner Identity

| Variable              | Default                        | Description                                                           |
| --------------------- | ------------------------------ | --------------------------------------------------------------------- |
| `FLUX_ORG_ID`         | Auto-detected from SKILL.md   | Organization ID. If set, validated against the SKILL.md `orgId`.      |
| `FLUX_RUNNER_TYPE`    | `fluxhive-openclaw-runner`    | Runner type identifier sent during handshake.                         |
| `FLUX_RUNNER_VERSION` | `0.1.0`                       | Version string sent during handshake.                                 |
| `FLUX_RUNNER_ID`      | Random UUID per process       | Instance ID for this runner. Persists for the lifetime of the process.|
| `FLUX_MACHINE_ID`     | `$HOSTNAME` or `unknown`      | Machine identifier sent during handshake.                             |

## Polling and Push

| Variable                  | Default | Min  | Description                                                          |
| ------------------------- | ------- | ---- | -------------------------------------------------------------------- |
| `FLUX_CADENCE_MINUTES`    | `15`    | `1`  | Interval in minutes between poll cycles.                             |
| `FLUX_PUSH_RECONNECT_MS`  | `5000`  | `250`| Base delay in milliseconds for WebSocket push reconnection backoff.  |

The push reconnect delay uses exponential backoff: `min(30000, base * 2^attempt)`.

## Backend Selection

| Variable              | Default | Description                                                                  |
| --------------------- | ------- | ---------------------------------------------------------------------------- |
| `FLUX_BACKEND`        | (unset) | Restrict which execution backend to use. Values: `openclaw`, `pi`, `claude-cli`, `codex-cli`. When unset, all available backends are registered. |
| `FLUX_ALLOW_DIRECT_CLI` | (unset) | Set to `1` or `true` to enable the Claude CLI backend alongside OpenClaw. By default, when OpenClaw is present, direct Claude CLI execution is disabled. |

Backend aliases are normalized internally:

| Input value                              | Resolves to   |
| ---------------------------------------- | ------------- |
| `openclaw`                               | `claude-cli`  |
| `claude`, `claude-code`, `code`          | `claude-cli`  |
| `codex`                                  | `codex-cli`   |
| `pi`                                     | `pi`          |

Note: `openclaw` as a `FLUX_BACKEND` filter value is treated as compatible with the OpenClaw backend. The normalization above applies to packet-level backend resolution within `execution.ts`.

## OpenClaw Gateway

| Variable                      | Default | Description                                                         |
| ----------------------------- | ------- | ------------------------------------------------------------------- |
| `OPENCLAW_GATEWAY_URL`        | (unset) | WebSocket URL for the OpenClaw gateway (e.g. `ws://127.0.0.1:18789`). If unset, OpenClaw backend is not registered. During `--service install`, auto-detected from `~/.openclaw/openclaw.json`. |
| `OPENCLAW_GATEWAY_TOKEN`      | (unset) | Authentication token for the OpenClaw gateway. If unset, auto-detected from `~/.openclaw/openclaw.json` (`gateway.auth.token`). |
| `OPENCLAW_GATEWAY_PASSWORD`   | (unset) | Password-based auth for the OpenClaw gateway (alternative to token). |
| `OPENCLAW_AGENT_ID`           | (unset) | Default agent ID for OpenClaw executions. If unset, the gateway uses its default. |

## PI Backend

| Variable             | Default             | Description                                        |
| -------------------- | ------------------- | -------------------------------------------------- |
| `FLUX_PI_AGENT_DIR`  | `~/.flux/pi-agent`  | Directory containing PI agent configuration files (`models.json`, `auth.json`). |

## Claude CLI Backend

| Variable     | Default               | Description                                                       |
| ------------ | --------------------- | ----------------------------------------------------------------- |
| `CLAUDE_BIN` | Auto-detected         | Path to the `claude` binary. If unset, searched in: `./node_modules/.bin/claude`, `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, then system `PATH`. |

## SKILL.md Protocol

On startup, the runner fetches the organization's SKILL.md manifest from:

```
GET {FLUX_HOST}/orgs/{FLUX_ORG_ID}/SKILL.md
```

Or, if `FLUX_ORG_ID` is not set:

```
GET {FLUX_HOST}/SKILL.md
```

The file must begin with YAML frontmatter in the following format:

```yaml
---
protocolVersion: "1"
orgId: "org_abc123"
product: "FluxHive"
updatedAt: "2025-01-15T00:00:00Z"
mcpHttpBase: "https://app.fluxhive.com/mcp/v1"
mcpPushWs: "wss://push.fluxhive.com/ws"
joinRequestUrl: "https://app.fluxhive.com/join"
---
```

### Required frontmatter fields

| Field              | Description                                          |
| ------------------ | ---------------------------------------------------- |
| `protocolVersion`  | Must be `"1"`. Any other value causes a fatal error. |
| `orgId`            | Organization identifier. Used to set `FLUX_ORG_ID` if not provided via env. |

### Optional frontmatter fields

| Field             | Description                                                        |
| ----------------- | ------------------------------------------------------------------ |
| `product`         | Product name string.                                               |
| `updatedAt`       | ISO 8601 timestamp of last update.                                 |
| `mcpHttpBase`     | MCP API base URL. Overrides the default `{FLUX_HOST}/mcp/v1`.     |
| `mcpPushWs`       | WebSocket URL for push notifications. Used if handshake does not provide one. |
| `joinRequestUrl`  | URL for join requests.                                             |

## Config Resolution Order

Configuration values are resolved in this order (highest priority first):

1. **Environment variables** set in the shell or `.env` / `.env.local` files.
2. **SKILL.md frontmatter** for `orgId`, `mcpHttpBase`, and `mcpPushWs`.
3. **Handshake response** for push configuration (`wsUrl`, `mode`) and batch size.
4. **Hardcoded defaults** in `config.ts` and `index.ts`.

For `FLUX_ORG_ID` specifically: if set via env, it is validated against SKILL.md. If not set, the value from SKILL.md is used.

For the MCP base URL: if `mcpHttpBase` is present in SKILL.md frontmatter and is a valid absolute or relative URL, it takes precedence. Otherwise, `{FLUX_HOST}/mcp/v1` is used.

## File Locations

| Path                          | Purpose                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `~/.flux/device.json`         | ED25519 keypair for device identity (mode `0600`).        |
| `~/.flux/device-tokens.json`  | Cached device tokens from OpenClaw gateway (mode `0600`). |
| `~/.flux/logs/runner.log`     | Service stdout log.                                       |
| `~/.flux/logs/runner.err.log` | Service stderr log.                                       |
| `~/.flux/pi-agent/`           | Default PI agent directory (models.json, auth.json).      |
| `~/.openclaw/openclaw.json`   | OpenClaw config (auto-detected for gateway URL and token). |
