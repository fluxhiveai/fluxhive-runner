# Getting Started

This guide walks through setting up and running `@fluxhive/runner` from source.

## Prerequisites

- **Node.js 20+** (LTS recommended)
- **pnpm** (the repo uses `pnpm@10.28.0` as its package manager)

## Option A: Download Pre-built Bundle

Download the latest release and verify its checksum:

```bash
mkdir -p ~/.flux && cd ~/.flux
curl -LO https://github.com/fluxhiveai/fluxhive-runner/releases/latest/download/fluxhive.mjs
curl -LO https://github.com/fluxhiveai/fluxhive-runner/releases/latest/download/fluxhive.mjs.sha256
shasum -a 256 -c fluxhive.mjs.sha256
```

Then skip to **Authenticate** below.

## Option B: Build from Source

```bash
git clone <repo-url> flux-runner
cd flux-runner
pnpm install
```

Compile from TypeScript:

```bash
pnpm build
```

To produce a single bundled file (`dist/fluxhive.mjs`):

```bash
pnpm bundle
```

## Authenticate

Before running, redeem an invite code to save credentials locally:

```bash
node dist/fluxhive.mjs access redeem --org <orgId> --invite <code> --label <name>
```

This saves `FLUX_TOKEN` and `FLUX_HOST` to `~/.flux/config.json`, which the runner reads at runtime. All credential files are automatically created with `0600` permissions (owner-only read/write).

Alternatively, you can set environment variables directly:

| Variable      | Description                                              |
| ------------- | -------------------------------------------------------- |
| `FLUX_TOKEN`  | API token for authenticating with the FluxHive MCP API   |
| `FLUX_HOST`   | Base URL of the FluxHive server (e.g. `https://app.fluxhive.com`) |

These can be set in your shell, in a `.env` file in the working directory, or in a `.env.local` file. The runner loads both `.env` and `.env.local` automatically on startup (Node.js 20+ `process.loadEnvFile`).

## Optional Environment Variables

There are many optional variables for configuring poll intervals, execution backends, and gateway connections. See [configuration.md](./configuration.md) for the complete reference.

Key optional variables:

| Variable                | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `FLUX_ORG_ID`           | Organization ID (auto-detected from SKILL.md)  |
| `FLUX_BACKEND`          | Restrict to a specific execution backend       |
| `FLUX_CADENCE_MINUTES`  | Poll interval in minutes (default: 15)         |
| `OPENCLAW_GATEWAY_URL`  | Enable OpenClaw backend via gateway WebSocket   |

## Running

Start the runner directly:

```bash
pnpm start
```

Or after building:

```bash
node dist/fluxhive.mjs
```

The runner will:

1. Load configuration and fetch SKILL.md from the server.
2. Authenticate via `/whoami` and `/handshake`.
3. Initialize available execution backends.
4. Begin polling for tasks (and connect via WebSocket if push mode is available).

All output is structured JSON, one line per log entry:

```json
{"ts":"2025-05-01T12:00:00.000Z","level":"info","message":"runner.start","fluxHost":"https://app.fluxhive.com","runnerType":"fluxhive-openclaw-runner"}
```

## Installing as a System Service

The runner can install itself as a persistent background service that starts on boot and restarts on failure:

```bash
# If you haven't already authenticated:
node dist/fluxhive.mjs access redeem --org <orgId> --invite <code> --label <name>

# Install and start the service
node dist/fluxhive.mjs runner install
```

This creates:

- **macOS**: A launchd plist at `~/Library/LaunchAgents/ai.fluxhive.runner.plist`
- **Linux**: A systemd user unit at `~/.config/systemd/user/fluxhive-runner.service`

The service reads environment variables from `~/.flux/.env` at runtime — secrets are never baked into the service definition.

## Verifying the Service

Check that the service is running:

```bash
node dist/fluxhive.mjs runner status
```

This prints the service state, PID (if running), and recent log output.

## Other Service Commands

```bash
# Restart the service
node dist/fluxhive.mjs runner restart

# Stop the service
node dist/fluxhive.mjs runner stop

# Uninstall the service completely
node dist/fluxhive.mjs runner uninstall
```

## Logs

Service logs are written to:

- `~/.flux/logs/runner.log` (stdout)
- `~/.flux/logs/runner.err.log` (stderr)

When running interactively (not as a service), all output goes to the terminal.
