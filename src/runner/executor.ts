/**
 * Task executor — the core claim-execute-complete loop.
 *
 * TaskExecutor takes a task ID (or packet), claims it via the MCP API,
 * selects the right execution backend, runs the task with a heartbeat
 * interval, and reports the result back. It handles:
 *   - 409 conflicts (task already claimed by another runner)
 *   - Missing packets (fails gracefully)
 *   - Unsupported backends (reports failure)
 *   - Heartbeat-driven abort/cancel signals
 *   - OpenClaw approval errors (escalates to human)
 */
import type { FluxMcpClient } from "./client.js";
import { McpHttpError } from "./client.js";
import type { McpTaskPacket } from "../types.js";
import {
  type RunnerExecutionBackend,
  packetTaskId,
  packetTaskType,
  renderPrompt,
  resolvePacketBackend,
} from "./execution.js";
import { isApprovalError } from "./openclaw_backend.js";

export type TaskExecutorOptions = {
  fluxClient: FluxMcpClient;
  executionBackends: RunnerExecutionBackend[];
  runnerType: string;
  runnerVersion: string;
  runnerInstanceId: string;
  machineId: string;
  backend?: string;
  heartbeatMs?: number;
};

export class TaskExecutor {
  private readonly opts: TaskExecutorOptions;

  constructor(opts: TaskExecutorOptions) {
    this.opts = opts;
  }

  /** Finds the first registered backend that can handle this packet's requested backend. */
  private resolveExecutionBackend(packet: McpTaskPacket): RunnerExecutionBackend | null {
    const requested = resolvePacketBackend(packet, this.opts.backend);
    if (!requested) return null;
    return this.opts.executionBackends.find((backend) => backend.canExecute(requested)) ?? null;
  }

  /**
   * Claims a task by ID, executes it, and reports the result.
   * If the claim returns 409 (already claimed), silently returns.
   * An optional hintedPacket is used as fallback if the claim response omits the packet.
   */
  async claimAndExecuteTask(taskId: string, hintedPacket?: McpTaskPacket): Promise<void> {
    let claim:
      | {
          sessionId: string;
          packet?: McpTaskPacket;
        }
      | undefined;
    try {
      claim = await this.opts.fluxClient.claimTask(taskId, {
        runnerType: this.opts.runnerType,
        runnerVersion: this.opts.runnerVersion,
        runnerInstanceId: this.opts.runnerInstanceId,
        machineId: this.opts.machineId,
        backend: this.opts.backend,
        format: "packet",
      });
    } catch (error) {
      if (error instanceof McpHttpError && error.status === 409) {
        return;
      }
      throw error;
    }

    const sessionId = claim.sessionId;
    const packet = claim.packet ?? hintedPacket;
    if (!packet) {
      await this.opts.fluxClient.completeTask(taskId, sessionId, {
        status: "failed",
        output: "Runner claim response missing packet payload",
      });
      return;
    }

    const executionBackend = this.resolveExecutionBackend(packet);
    if (!executionBackend) {
      const requested = resolvePacketBackend(packet, this.opts.backend) || "unknown";
      await this.opts.fluxClient.completeTask(taskId, sessionId, {
        status: "failed",
        output: `Runner does not support execution backend: ${requested}`,
      });
      return;
    }

    const taskType = packetTaskType(packet);
    const prompt = renderPrompt(packet);
    const startTime = Date.now();
    const abortController = new AbortController();
    const heartbeatRequired = packet.policy?.heartbeatRequired !== false;

    let cancelled = false;
    let heartbeatError: unknown = undefined;
    const heartbeatMs = Math.max(10_000, this.opts.heartbeatMs ?? 30_000);
    const heartbeatTimer = heartbeatRequired
      ? setInterval(async () => {
          try {
            const heartbeat = await this.opts.fluxClient.heartbeat(taskId, sessionId, {
              phase: "executing",
            });
            if (heartbeat.shouldAbort || heartbeat.cancelPending) {
              cancelled = true;
              abortController.abort();
            }
          } catch (error) {
            heartbeatError = error instanceof Error ? error : new Error(String(error));
          }
        }, heartbeatMs)
      : null;

    try {
      const result = await executionBackend.execute({
        taskId,
        taskType,
        packet,
        prompt,
        startedAt: startTime,
        abortSignal: abortController.signal,
      });
      const status = cancelled ? "cancelled" : result.status ?? "done";
      await this.opts.fluxClient.completeTask(taskId, sessionId, {
        status,
        output:
          typeof result.output === "string" && result.output.trim().length > 0
            ? result.output
            : status === "cancelled"
              ? "Cancelled by user request"
              : "(empty response)",
        tokensUsed: result.tokensUsed,
        costUsd: result.costUsd,
        durationMs:
          typeof result.durationMs === "number" ? result.durationMs : Date.now() - startTime,
        model: result.model,
        usageJson: result.usageJson,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const status = cancelled || abortController.signal.aborted ? "cancelled" : "failed";
      try {
        await this.opts.fluxClient.completeTask(taskId, sessionId, {
          status,
          output: `Runner execution error (${taskType}): ${errorMsg}`,
          durationMs: Math.max(0, Date.now() - startTime),
        });
      } catch {
        // Ignore secondary completion failures so we can still surface escalation.
      }
      if (executionBackend.id === "openclaw" && isApprovalError(error)) {
        try {
          await this.opts.fluxClient.escalateTask(
            taskId,
            sessionId,
            "OpenClaw approval required",
            "Approve the pending execution and retry task",
          );
        } catch {
          // ignore escalation failures
        }
      }
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (heartbeatError) {
        // Heartbeat failures are non-fatal while execution is ongoing; emit as plain stderr.
        // eslint-disable-next-line no-console
        console.warn(`[runner] heartbeat warning for ${taskId}: ${String(heartbeatError)}`);
      }
    }
  }

  /** Convenience: extracts the task ID from a packet and delegates to claimAndExecuteTask. */
  async claimAndExecuteFromPacket(packet: McpTaskPacket): Promise<void> {
    const taskId = packetTaskId(packet);
    if (!taskId) {
      return;
    }
    await this.claimAndExecuteTask(taskId, packet);
  }
}
