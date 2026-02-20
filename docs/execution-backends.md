# Execution Backends

The runner uses a pluggable backend system for executing tasks. Each backend implements the `RunnerExecutionBackend` interface and is registered at startup based on availability and configuration.

## Backend Interface

All backends implement the following interface defined in `execution.ts`:

```typescript
interface RunnerExecutionBackend {
  readonly id: string;
  canExecute(backend: string): boolean;
  execute(request: RunnerExecutionRequest): Promise<RunnerExecutionResult>;
}
```

Where:

```typescript
type RunnerExecutionRequest = {
  taskId: string;
  taskType: string;
  packet: McpTaskPacket;
  prompt: string;
  startedAt: number;
  abortSignal: AbortSignal;
};

type RunnerExecutionResult = {
  status?: "done" | "failed" | "cancelled";
  output?: string;
  tokensUsed?: number;
  costUsd?: number;
  durationMs?: number;
};
```

## OpenClaw Backend

**File**: `openclaw_backend.ts` (uses `openclaw.ts` and `device-identity.ts`)

**ID**: `openclaw`

**Handles**: `openclaw`, `claude-cli`, `codex-cli` (by default)

The OpenClaw backend connects to an OpenClaw gateway via WebSocket and executes tasks through it. This is the primary production backend.

### Connection and Authentication

- Connects to the gateway URL specified by `OPENCLAW_GATEWAY_URL`.
- Authenticates using a challenge-response protocol with ED25519 device signatures.
- Token priority: stored device token > `OPENCLAW_GATEWAY_TOKEN` env > auto-detected from `~/.openclaw/openclaw.json`.
- On device token mismatch, automatically clears the stored token and retries with the shared token.

### Session Key Derivation

Each task execution uses a deterministic session key to maintain conversation context:

| Task Type          | Session Key Format                                                          |
| ------------------ | --------------------------------------------------------------------------- |
| `conductor-chat`   | `agent:{agentId}:flux:org:{orgId}:stream:{streamId}:thread:{threadId}`     |
| `cadence`          | `agent:{agentId}:flux:org:{orgId}:stream:{streamId}:cadence:{cadenceKey}`  |
| Other              | `agent:{agentId}:flux:org:{orgId}:stream:{streamId}:task`                  |

The `cadenceKey` is extracted from the task input JSON if present.

### Payload Extraction

The gateway returns an array of payloads, each with optional `text`, `mediaUrl`, and `isError` fields. The backend:

- Concatenates all non-empty `text` fields, separated by double newlines.
- Checks for `isError` payloads to determine failure status.
- Reports token usage from the `usage` field (input, output, total).

### Approval Flows

If execution fails with an approval-related error (message contains "approval", "operator.approvals", or "exec.approval"), the runner:

1. Reports the task as `failed` via `completeTask`.
2. Calls `escalateTask` to notify the server that operator approval is needed.

## PI Backend

**File**: `pi_backend.ts`

**ID**: `pi`

**Handles**: `pi` only

The PI backend runs a local LLM session using the `@mariozechner/pi-coding-agent` library.

### Prerequisites

- A readable `models.json` file must exist at `{FLUX_PI_AGENT_DIR}/models.json` (default: `~/.flux/pi-agent/models.json`).
- The preflight check verifies this file exists. If not, the PI backend is not registered (unless `FLUX_BACKEND=pi`, which makes it a fatal error).

### Execution Flow

1. Validates that `packet.prompt.rendered` and `packet.execution.model` are present.
2. Parses the model reference as `provider/model` (e.g. `anthropic/claude-3-haiku`).
3. Looks up the model in the `ModelRegistry` and resolves API key from `AuthStorage`.
4. Creates a one-shot agent session with `createAgentSession()` (no tools, thinking off).
5. Subscribes to streaming text deltas during execution.
6. Handles timeouts from `execution.timeoutSec` or `policy.taskTimeoutSeconds`.
7. Extracts the final output from streamed text or the last assistant message.

### Output Schema Validation

If `packet.execution.outputSchemaJson` is set, the PI backend validates the output against the JSON Schema using Ajv after execution. If validation fails, the task is reported as `failed` with the validation error details.

### Token Usage

Token usage and cost are extracted from the assistant message's `usage` field:

- `tokensUsed` = `usage.totalTokens`
- `costUsd` = `usage.cost.total`

## Claude CLI Backend

**File**: `claude_cli_backend.ts`

**ID**: `claude-cli`

**Handles**: `claude-cli` only

The Claude CLI backend spawns the `claude` binary as a subprocess and captures its JSON output.

### Binary Resolution

The backend searches for the `claude` binary in this order:

1. `CLAUDE_BIN` environment variable
2. `./node_modules/.bin/claude` (project-local)
3. `~/.local/bin/claude`
4. `/usr/local/bin/claude`
5. `/opt/homebrew/bin/claude`
6. System `PATH` (fallback: `claude`)

### Execution

The binary is invoked with:

```bash
claude -p "<prompt>" --output-format json [--model <model>] [--allowedTools <tools>]
```

- `prompt`: The rendered prompt from the task packet.
- `model`: From `packet.execution.model` if set.
- `allowedTools`: From `packet.execution.allowedTools` if set, joined by comma.

### Output Parsing

The stdout is parsed with `parseClaudeCliOutput()`:

1. Tries to parse as JSON. If successful, extracts `.result` or `.response` field if it is a string.
2. If not valid JSON, tries to extract the first JSON object (`{...}`) from the output.
3. Falls back to the raw trimmed output.

### Error Handling

- Non-zero exit code: reported as `failed` with stderr (or stdout) as the error message.
- Abort signal: sends `SIGTERM` to the child process, reports as `cancelled`.

## Backend Selection

When a task arrives, the backend is selected through this resolution chain (first non-null wins):

1. `packet.execution.backend` -- The task packet explicitly requests a backend.
2. `packet.prompt.backend` -- The prompt plan specifies a backend.
3. `FLUX_BACKEND` environment variable -- Global filter set by the operator.
4. Default: `"claude-cli"`.

The resolved backend name is then normalized (see the alias table in [configuration.md](./configuration.md)) and matched against each registered backend's `canExecute()` method.

If no registered backend can handle the requested backend, the task is completed as `failed` with the message "Runner does not support execution backend: {name}".

### Backend Registration Logic

At startup, backends are conditionally registered:

| Backend     | Registered when                                                                  |
| ----------- | -------------------------------------------------------------------------------- |
| OpenClaw    | `OPENCLAW_GATEWAY_URL` is set and gateway ping succeeds                          |
| PI          | `FLUX_PI_AGENT_DIR/models.json` is readable                                      |
| Claude CLI  | OpenClaw is not present, OR `FLUX_ALLOW_DIRECT_CLI=1` is set                    |

If no backends are registered, the runner exits with a fatal error.

When OpenClaw is registered, it handles `openclaw`, `claude-cli`, and `codex-cli` backend requests by default. This means the Claude CLI backend is typically unnecessary when OpenClaw is active -- it acts as the proxy for those backend types.

## Adding a Custom Backend

To add a new execution backend:

1. Create a new file (e.g. `my_backend.ts`) that implements `RunnerExecutionBackend`:

```typescript
import type {
  RunnerExecutionBackend,
  RunnerExecutionRequest,
  RunnerExecutionResult,
} from "./execution.js";
import { normalizeExecutionBackend } from "./execution.js";

export class MyExecutionBackend implements RunnerExecutionBackend {
  readonly id = "my-backend";

  canExecute(backend: string): boolean {
    return normalizeExecutionBackend(backend) === "my-backend";
  }

  async execute(request: RunnerExecutionRequest): Promise<RunnerExecutionResult> {
    // Access the full task packet via request.packet
    // Use request.prompt for the rendered prompt text
    // Respect request.abortSignal for cancellation

    const output = "result from my backend";

    return {
      status: "done",
      output,
      durationMs: Date.now() - request.startedAt,
    };
  }
}
```

2. Register it in `index.ts` alongside the existing backends:

```typescript
import { MyExecutionBackend } from "./my_backend.js";

// After other backend registrations:
const myBackend = new MyExecutionBackend();
executionBackends.push(myBackend);
```

3. Optionally add the backend name to `normalizeExecutionBackend()` in `execution.ts` if you need alias support.

### Implementation considerations

- **Abort signal**: Always listen to `request.abortSignal` and terminate work when it fires. The heartbeat loop may trigger abortion if the server requests cancellation.
- **Status values**: Return `"done"` for success, `"failed"` for errors, `"cancelled"` if the abort signal fired.
- **Empty output**: If no output is produced, the executor defaults to `"(empty response)"` for done status or `"Cancelled by user request"` for cancelled status.
- **Duration**: If you do not return `durationMs`, the executor calculates it from `Date.now() - startedAt`.
