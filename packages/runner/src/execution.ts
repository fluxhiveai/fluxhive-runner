import type { McpCompleteStatus, McpTaskPacket } from "./types.js";

export type RunnerExecutionRequest = {
  taskId: string;
  taskType: string;
  packet: McpTaskPacket;
  prompt: string;
  startedAt: number;
  abortSignal: AbortSignal;
};

export type RunnerExecutionResult = {
  status?: McpCompleteStatus;
  output?: string;
  tokensUsed?: number;
  costUsd?: number;
  durationMs?: number;
};

export interface RunnerExecutionBackend {
  readonly id: string;
  canExecute(backend: string): boolean;
  execute(request: RunnerExecutionRequest): Promise<RunnerExecutionResult>;
}

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

