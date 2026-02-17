import type { OpenClawClient } from "./openclaw.js";
import type { OpenClawResult } from "./types.js";
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
    };
  }
}

