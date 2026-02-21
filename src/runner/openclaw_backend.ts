/**
 * OpenClaw execution backend.
 *
 * Routes task execution through the OpenClaw gateway WebSocket client.
 * Handles session key derivation (different key patterns for conductor-chat,
 * cadence, and generic tasks) so each task type gets its own conversation
 * context in the gateway.
 *
 * Accepts multiple backend aliases (openclaw, claude-cli, codex-cli) since
 * when OpenClaw is available it serves as the primary execution path for
 * all agent types.
 */
import type { OpenClawClient } from "./openclaw.js";
import type { OpenClawResult } from "../types.js";
import {
  type RunnerExecutionBackend,
  type RunnerExecutionRequest,
  type RunnerExecutionResult,
  normalizeExecutionBackend,
  packetInput,
  packetStreamId,
  packetThreadId,
  packetTaskType,
} from "./execution.js";

/** Extracts a cadenceKey from the task input JSON, if present. */
function parseCadenceKey(rawInput: string | undefined): string | undefined {
  if (!rawInput || rawInput.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(rawInput) as Record<string, unknown>;
    if (typeof parsed.cadenceKey === "string" && parsed.cadenceKey.trim().length > 0) {
      return parsed.cadenceKey.trim();
    }
  } catch {
    // ignore malformed JSON inputs
  }
  return undefined;
}

/** Concatenates all text payloads from an OpenClaw result into a single output string. */
function extractOutput(result: OpenClawResult): string {
  const lines: string[] = [];
  for (const payload of result.payloads) {
    if (typeof payload.text === "string" && payload.text.trim().length > 0) {
      lines.push(payload.text.trim());
    }
  }
  return lines.join("\n\n");
}

function hasErrorPayload(result: OpenClawResult): boolean {
  return result.payloads.some((payload) => payload.isError === true);
}

/** Checks if an error is an OpenClaw approval/authorization error (requires human approval). */
export function isApprovalError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("approval") ||
    lower.includes("operator.approvals") ||
    lower.includes("exec.approval")
  );
}

export type OpenClawExecutionBackendOptions = {
  client: OpenClawClient;
  orgId: string;
  openclawAgentId?: string;
  aliases?: string[];
};

export class OpenClawExecutionBackend implements RunnerExecutionBackend {
  readonly id = "openclaw";
  private readonly opts: OpenClawExecutionBackendOptions;
  private readonly aliases: Set<string>;

  constructor(opts: OpenClawExecutionBackendOptions) {
    this.opts = opts;
    this.aliases = new Set(
      (opts.aliases && opts.aliases.length > 0
        ? opts.aliases
        : ["openclaw", "claude-cli", "codex-cli"]
      )
        .map((value) => normalizeExecutionBackend(value))
        .filter((value): value is string => Boolean(value)),
    );
  }

  canExecute(backend: string): boolean {
    const normalized = normalizeExecutionBackend(backend);
    return Boolean(normalized && this.aliases.has(normalized));
  }

  /**
   * Derives a session key for the OpenClaw gateway.
   * The key pattern varies by task type to maintain separate conversation contexts:
   *   - conductor-chat → keyed by thread ID (persistent chat sessions)
   *   - cadence → keyed by cadence key (recurring scheduled tasks)
   *   - other → generic `:task` suffix (one-off executions)
   */
  private deriveSessionKey(packet: RunnerExecutionRequest["packet"]): string {
    const agentId = this.opts.openclawAgentId || "main";
    const streamId = packetStreamId(packet);
    const base = `agent:${agentId}:flux:org:${this.opts.orgId}:stream:${streamId}`;
    const type = packetTaskType(packet);
    if (type === "conductor-chat") {
      return `${base}:thread:${packetThreadId(packet) || "main"}`;
    }
    if (type === "cadence") {
      const cadenceKey = parseCadenceKey(packetInput(packet)) || "tick";
      return `${base}:cadence:${cadenceKey}`;
    }
    return `${base}:task`;
  }

  async execute(request: RunnerExecutionRequest): Promise<RunnerExecutionResult> {
    const result = await this.opts.client.execute({
      prompt: request.prompt,
      sessionKey: this.deriveSessionKey(request.packet),
      agentId: this.opts.openclawAgentId,
      abortSignal: request.abortSignal,
    });
    const output = extractOutput(result);
    const errored = hasErrorPayload(result);
    const status = result.aborted ? "cancelled" : errored ? "failed" : "done";
    const usageObj: Record<string, unknown> = {};
    if (result.usage?.input !== undefined) usageObj.inputTokens = result.usage.input;
    if (result.usage?.output !== undefined) usageObj.outputTokens = result.usage.output;
    if (result.usage?.total !== undefined) usageObj.tokensUsed = result.usage.total;
    if (result.model) usageObj.model = result.model;
    if (result.provider) usageObj.provider = result.provider;

    return {
      status,
      output:
        output.length > 0
          ? output
          : status === "cancelled"
            ? "Cancelled by user request"
            : "(empty response)",
      tokensUsed: result.usage?.total,
      durationMs:
        typeof result.durationMs === "number"
          ? result.durationMs
          : Math.max(0, Date.now() - request.startedAt),
      model: result.model,
      usageJson: Object.keys(usageObj).length > 0 ? JSON.stringify(usageObj) : undefined,
    };
  }
}
