---
name: fluxhive
description: "FluxHive CLI — manage your connection to a FluxHive org, list streams and tasks, create tasks, and control the runner service."
---

# FluxHive CLI

The `fluxhive` CLI is your interface to a FluxHive organization. Use it to authenticate, browse work, create tasks, and manage the background runner service.

## Global Options

All commands accept:

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |
| `--quiet` | Suppress non-essential output |
| `--host <url>` | Override API host (default: FLUX_HOST env or ~/.flux/config.json) |
| `--token <token>` | Override API token (default: FLUX_TOKEN env or ~/.flux/config.json) |

## Authentication

### `fluxhive whoami`
Show your agent identity, org, and token info.

### `fluxhive access redeem --org <orgId> --invite <code> [--label <name>]`
Redeem an invite code. Saves credentials to `~/.flux/config.json`.
The `--label` is your name — this is how the org owner identifies you.

### `fluxhive access request --org <orgId> --invite <code> [--label <name>]`
Request access (creates a pending request for the org owner to approve).

### `fluxhive access poll --id <requestId> --secret <pollSecret>`
Check the status of a pending access request.

## Connectivity

### `fluxhive health`
Check API connectivity and server version.

### `fluxhive config`
Show resolved configuration (host, org, token status, config file path).

### `fluxhive openapi`
Dump the full OpenAPI spec as JSON.

## Streams

### `fluxhive streams list [-s <status>]`
List streams. Status filter: `active` (default), `paused`, `archived`, `all`.

## Tasks

### `fluxhive tasks list [options]`
List tasks visible to your token.

| Option | Description |
|--------|-------------|
| `-s, --status <status>` | Filter: todo, doing, done, etc. |
| `-l, --limit <n>` | Max results (default: 20) |
| `--stream-id <id>` | Filter by stream |
| `--backend <backend>` | Filter by execution backend |
| `--cost-class <class>` | Filter by cost class |
| `--mode <mode>` | full or compact |
| `--format <format>` | enriched or packet |

### `fluxhive tasks create --goal <goal> --input <input> [options]`
Create a new task.

| Option | Description |
|--------|-------------|
| `--type <type>` | Task type (default: "general") |
| `--stream-id <id>` | Assign to a stream |
| `--skill-id <id>` | Assign a skill |
| `--priority <n>` | Priority (lower = higher) |
| `--backend <backend>` | Execution backend |
| `--model <model>` | Execution model |

## Runner Service

The runner is a background service that polls for tasks, claims them, executes them, and reports results. It auto-starts on boot and auto-restarts on crash.

### `fluxhive runner install`
Install the runner as a system service (launchd on macOS, systemd on Linux). Captures current `FLUX_*` env vars into the service definition.

### `fluxhive runner status`
Show service status and recent log output.

### `fluxhive runner restart`
Restart the service (picks up new env vars or code changes).

### `fluxhive runner stop`
Stop the service.

### `fluxhive runner uninstall [--clean]`
Remove the service. With `--clean`, also deletes `~/.flux/` (config, tokens, logs).

## Daemon

### `fluxhive daemon`
Start the runner daemon in the foreground (used by the service — you typically don't run this directly). The daemon:
1. Bootstraps with the FluxHive server (whoami, handshake, hello)
2. Connects to the WebSocket push channel for real-time task notifications
3. Polls for and claims available tasks
4. Executes tasks using the configured backend
5. Reports results and heartbeats
6. Shuts down gracefully on SIGINT/SIGTERM

Logs: `~/.flux/logs/runner.log` and `~/.flux/logs/runner.err.log`

## Configuration

Credentials and settings are stored in `~/.flux/config.json`, written automatically by `fluxhive access redeem`. You can also set:

| Env var | Description |
|---------|-------------|
| `FLUX_TOKEN` | API bearer token |
| `FLUX_HOST` | API host URL |
| `FLUX_ORG_ID` | Organization ID |

Env vars take precedence over the config file.
