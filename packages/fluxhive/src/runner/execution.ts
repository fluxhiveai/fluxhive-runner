/**
 * Execution abstraction layer.
 *
 * Defines the RunnerExecutionBackend interface that all backends (OpenClaw,
 * PI, Claude CLI) implement, plus packet helper functions for extracting
 * fields from the variable-shape McpTaskPacket.
 *
 * A task packet may have fields at the top level or nested under `task` —
 * the `packet*` helpers normalize both shapes into a single accessor.
 */
import type { McpCompleteStatus, McpTaskPacket } from "../types.js";

/** Everything an execution backend needs to run a single task. */
export type RunnerExecutionRequest = {
  taskId: string;
  taskType: string;
  packet: McpTaskPacket;
  prompt: string;
  startedAt: number;
  abortSignal: AbortSignal;
};

/** What a backend returns after executing a task. */
export type RunnerExecutionResult = {
  status?: McpCompleteStatus;
  output?: string;
  tokensUsed?: number;
  costUsd?: number;
  durationMs?: number;
};

/**
 * A pluggable execution backend. Each backend declares which backend IDs
 * it can handle (via canExecute) and provides an execute method.
 */
export interface RunnerExecutionBackend {
  readonly id: string;
  canExecute(backend: string): boolean;
  execute(request: RunnerExecutionRequest): Promise<RunnerExecutionResult>;
}

/**
 * Normalizes a backend name to a canonical form.
 * Maps aliases like "openclaw", "claude", "claude-code", "code" → "claude-cli"
 * and "codex" → "codex-cli".
 */
export function normalizeExecutionBackend(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "openclaw" ||
    normalized === "claude" ||
    normalized === "claude-code" ||
    normalized === "code"
  ) {
    return "claude-cli";
  }
  if (normalized === "codex") {
    return "codex-cli";
  }
  return normalized;
}

// --- Packet field accessors ---
// McpTaskPacket fields can live at the top level or nested under `task`.
// These helpers check both locations so callers don't need to worry about shape.

export function packetTaskId(packet: McpTaskPacket): string | undefined {
  return packet.task?.id || packet.taskId;
}

export function packetTaskType(packet: McpTaskPacket): string {
  return packet.task?.type || packet.type || "task";
}

export function packetStreamId(packet: McpTaskPacket): string {
  return packet.task?.streamId || packet.streamId || "unknown-stream";
}

export function packetThreadId(packet: McpTaskPacket): string | undefined {
  return packet.task?.threadId;
}

export function packetInput(packet: McpTaskPacket): string | undefined {
  return packet.task?.input;
}

/**
 * Builds the final prompt string to send to the execution backend.
 * Prefers `packet.prompt.rendered` (server-rendered). Falls back to
 * assembling the promptPlan template + vars + context + task fields.
 */
export function renderPrompt(packet: McpTaskPacket): string {
  const rendered = packet.prompt?.rendered;
  if (typeof rendered === "string" && rendered.trim().length > 0) {
    return rendered;
  }

  const template = packet.promptPlan?.template || "";
  const vars = packet.promptPlan?.vars || {};
  const context = packet.context || {};
  return [
    template,
    "",
    "## Vars",
    JSON.stringify(vars, null, 2),
    "",
    "## Context",
    JSON.stringify(context, null, 2),
    "",
    "## Task",
    JSON.stringify(packet.task || {}, null, 2),
  ]
    .filter((line) => typeof line === "string")
    .join("\n");
}

/**
 * Determines which execution backend a packet should use.
 * Checks `execution.backend`, then `prompt.backend`, then the runner-level
 * fallback. Defaults to "claude-cli" if nothing is specified.
 */
export function resolvePacketBackend(
  packet: McpTaskPacket,
  fallbackBackend?: string,
): string | null {
  return (
    normalizeExecutionBackend(packet.execution?.backend) ||
    normalizeExecutionBackend(packet.prompt?.backend) ||
    normalizeExecutionBackend(fallbackBackend) ||
    "claude-cli"
  );
}
