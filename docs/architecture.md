# Architecture

This document describes the internal architecture of `@fluxhive/runner`, a standalone CLI that connects to the FluxHive MCP API to poll for tasks, claim them, execute them via pluggable backends, and report results.

## Runner Lifecycle

The runner follows a strict startup sequence:

1. **Config load** -- Read environment variables and `.env` files via `loadRunnerConfig()` in `config.ts`. Required vars (`FLUX_TOKEN`, `FLUX_HOST`) are validated immediately.
2. **SKILL.md fetch** -- The runner fetches the organization's `SKILL.md` manifest from the server. YAML frontmatter is parsed to extract `protocolVersion`, `orgId`, `mcpHttpBase`, and `mcpPushWs`.
3. **Whoami** -- Calls `GET /whoami` on the MCP API to verify the token and retrieve agent metadata.
4. **Handshake** -- Calls `POST /handshake` to register the runner instance with the server. The server responds with push configuration and batch size limits.
5. **Hello** -- Calls `POST /hello` as a non-critical connectivity check (failures are logged but not fatal).
6. **Backend init** -- Each execution backend (OpenClaw, PI, Claude CLI) is initialized and preflight-checked. Only backends that pass preflight are registered.
7. **Push client start** -- If the handshake response provides a WebSocket URL and push mode is not `"polling"`, a `FluxPushClient` connects for real-time task notifications.
8. **Cadence loop start** -- A `CadenceLoop` begins polling on a configurable interval.
9. **Task claim and execute** -- When tasks are discovered (via push or poll), `TaskExecutor` claims, executes, and completes them.
10. **Shutdown** -- On `SIGINT` or `SIGTERM`, the cadence loop stops, the push client disconnects, and the OpenClaw client closes.

## Component Diagram

```
index.ts (entry point)
  |
  +-- config.ts
  |     Loads env vars, fetches SKILL.md, resolves MCP base URL
  |
  +-- client.ts (FluxMcpClient)
  |     HTTP client for MCP API: whoami, handshake, hello,
  |     listTasks, claimTask, heartbeat, completeTask, escalateTask,
  |     mintPushTicket
  |
  +-- push.ts (FluxPushClient)
  |     WebSocket client for real-time task notifications
  |     Emits "task.available" events -> triggers cadence tick
  |
  +-- cadence.ts (CadenceLoop)
  |     Interval-based polling loop
  |     Calls listTasks -> drains all pending tasks -> claims and executes
  |
  +-- executor.ts (TaskExecutor)
  |     Claims a task via MCP API, selects a backend, runs heartbeats,
  |     executes, and reports result (done/failed/cancelled)
  |
  +-- execution.ts
  |     RunnerExecutionBackend interface, prompt rendering,
  |     backend resolution, packet helpers
  |
  +-- openclaw_backend.ts (OpenClawExecutionBackend)
  |     +-- openclaw.ts (OpenClawClient) -- WebSocket gateway client
  |     +-- device-identity.ts -- ED25519 keypair, device auth
  |
  +-- pi_backend.ts (PiExecutionBackend)
  |     Local LLM via @mariozechner/pi-coding-agent libs
  |
  +-- claude_cli_backend.ts (ClaudeCliExecutionBackend)
  |     Spawns `claude` binary as subprocess
  |
  +-- service.ts
        --service install|restart|stop|uninstall|status
        launchd (macOS) / systemd (Linux)
```

## Task Flow

```
            +---------------------+
            |  FluxPushClient     |     (WebSocket)
            |  "task.available"   |--+
            +---------------------+  |
                                     |  cadence.triggerNow()
            +---------------------+  |
            |  CadenceLoop        |<-+
            |  (interval timer)   |
            +---------------------+
                     |
                     | listTasks(status="todo")
                     v
            +---------------------+
            |  FluxMcpClient      |
            |  GET /tasks         |
            +---------------------+
                     |
                     | for each task packet
                     v
            +---------------------+
            |  TaskExecutor       |
            |  claimAndExecute()  |
            +---------------------+
                     |
      +--------------+--------------+
      |              |              |
      v              v              v
  OpenClaw         PI          Claude CLI
  Backend        Backend        Backend
      |              |              |
      v              v              v
  completeTask(taskId, sessionId, result)
```

### Detailed claim-and-execute sequence:

1. `TaskExecutor.claimAndExecuteTask()` calls `POST /tasks/:id/claim` to atomically claim the task. A 409 response means another runner already claimed it -- silently skip.
2. The claim response includes a `sessionId` and optionally a full `packet`.
3. `resolveExecutionBackend()` determines which registered backend handles this task, based on `packet.execution.backend`, `packet.prompt.backend`, `FLUX_BACKEND` env, or the default `"claude-cli"`.
4. A heartbeat timer starts (default 30s interval), calling `POST /tasks/:id/heartbeat`. If the server responds with `shouldAbort` or `cancelPending`, the `AbortController` fires.
5. The backend's `execute()` method runs the prompt. Each backend handles abort signals to support cancellation.
6. On completion (or error), the runner calls `POST /tasks/:id/complete` with status (`done`, `failed`, or `cancelled`), output text, token usage, cost, and duration.
7. If an OpenClaw execution fails due to an approval requirement, the runner also calls `POST /tasks/:id/escalate` to notify the server.

## Push vs Polling

The runner supports two task discovery mechanisms that operate together:

### Push mode (WebSocket)

- `FluxPushClient` connects to a WebSocket endpoint provided by the handshake response (or SKILL.md frontmatter `mcpPushWs`).
- Before connecting, it mints a short-lived push ticket via `POST /mcp/v1/push-ticket`.
- The server sends `{"type": "task.available"}` messages when new tasks are queued.
- On receiving a push event, `cadence.triggerNow()` is called, which immediately runs the poll-claim-execute cycle.
- Reconnection uses exponential backoff (base delay from `FLUX_PUSH_RECONNECT_MS`, capped at 30 seconds).
- A ping frame is sent every 20 seconds to keep the connection alive.

### Polling mode (CadenceLoop)

- A `setInterval` timer fires every `FLUX_CADENCE_MINUTES` minutes (default 15).
- Each tick calls `listTasks(status="todo")` and drains all available tasks by iterating pages until fewer tasks than `limit` are returned.
- Tasks are claimed and executed sequentially within each tick.
- If a tick is already in flight when `triggerNow()` is called, a re-run is queued (but not stacked).

Push mode is preferred for low-latency task pickup. The cadence loop acts as a fallback to catch any tasks missed by push or to handle scenarios where the WebSocket is temporarily disconnected.

## Device Identity

The runner generates an **ED25519 keypair** on first run, stored at `~/.flux/device.json` (file mode `0600`). This identity is used for OpenClaw gateway authentication:

- `deviceId` is derived as the SHA-256 hash of the raw public key bytes.
- Authentication payloads are signed with the private key and sent during the gateway `connect` handshake.
- Device tokens received from the gateway are cached in `~/.flux/device-tokens.json` for reuse across connections.
- If a stored device token is rejected (mismatch), the runner automatically falls back to the shared gateway token and retries.

## Service Management

The runner can install itself as a persistent user-level service:

```
node dist/index.js --service install
```

### macOS (launchd)

- Generates a plist at `~/Library/LaunchAgents/ai.fluxhive.runner.plist`.
- Uses `RunAtLoad` and `KeepAlive` for automatic restart.
- Loads via `launchctl bootstrap` (modern API) with `launchctl load` as fallback.
- Logs to `~/.flux/logs/runner.log` and `~/.flux/logs/runner.err.log`.

### Linux (systemd)

- Generates a user unit at `~/.config/systemd/user/fluxhive-runner.service`.
- Configured with `Restart=always` and `RestartSec=5`.
- Enables `loginctl enable-linger` so the service persists after logout.
- Logs to `~/.flux/logs/runner.log` and `~/.flux/logs/runner.err.log`.

### Available commands

| Command                        | Description                          |
| ------------------------------ | ------------------------------------ |
| `--service install`            | Install, enable, and start service   |
| `--service restart`            | Restart the running service          |
| `--service stop`               | Stop the service                     |
| `--service uninstall`          | Stop, disable, and remove service    |
| `--service status`             | Show service state and recent logs   |

Both platforms build a minimal `PATH` that includes common Node.js version manager directories (nvm, fnm, volta, asdf, pnpm, bun) so the service can locate `node` without a login shell.
