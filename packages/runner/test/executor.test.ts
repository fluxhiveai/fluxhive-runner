import { describe, expect, it, vi } from "vitest";
import { McpHttpError } from "../src/client.ts";
import { TaskExecutor } from "../src/executor.ts";
import type { RunnerExecutionBackend, RunnerExecutionRequest } from "../src/execution.ts";
import type { McpTaskPacket } from "../src/types.ts";

type FluxClientMock = {
  claimTask: ReturnType<typeof vi.fn>;
  completeTask: ReturnType<typeof vi.fn>;
  escalateTask: ReturnType<typeof vi.fn>;
  heartbeat: ReturnType<typeof vi.fn>;
};

function createFluxClientMock(): FluxClientMock {
  return {
    claimTask: vi.fn(),
    completeTask: vi.fn().mockResolvedValue({ ok: true }),
    escalateTask: vi.fn().mockResolvedValue({ ok: true }),
    heartbeat: vi.fn().mockResolvedValue({ shouldAbort: false }),
  };
}

function makeBackend(options: {
  id?: string;
  canExecute?: (backend: string) => boolean;
  execute?: (request: RunnerExecutionRequest) => Promise<{
    status?: "done" | "failed" | "cancelled";
    output?: string;
    tokensUsed?: number;
    costUsd?: number;
    durationMs?: number;
  }>;
} = {}): RunnerExecutionBackend {
  return {
    id: options.id ?? "test-backend",
    canExecute: options.canExecute ?? (() => true),
    execute:
      options.execute ??
      (async () => {
        return {
          status: "done",
          output: "ok",
        };
      }),
  };
}

function makeExecutor(fluxClient: FluxClientMock, backends: RunnerExecutionBackend[]) {
  return new TaskExecutor({
    fluxClient: fluxClient as never,
    executionBackends: backends,
    runnerType: "test",
    runnerVersion: "1",
    runnerInstanceId: "instance-1",
    machineId: "machine-1",
    backend: undefined,
    heartbeatMs: 10,
  });
}

describe("TaskExecutor", () => {
  it("returns early when claim conflicts (409)", async () => {
    const fluxClient = createFluxClientMock();
    fluxClient.claimTask.mockRejectedValue(
      new McpHttpError("conflict", { status: 409, body: { error: "conflict" } }),
    );
    const executor = makeExecutor(fluxClient, [makeBackend()]);

    await expect(executor.claimAndExecuteTask("task-1")).resolves.toBeUndefined();
    expect(fluxClient.completeTask).not.toHaveBeenCalled();
  });

  it("fails task when claim response is missing packet", async () => {
    const fluxClient = createFluxClientMock();
    fluxClient.claimTask.mockResolvedValue({ sessionId: "session-1" });
    const executor = makeExecutor(fluxClient, [makeBackend()]);

    await executor.claimAndExecuteTask("task-1");

    expect(fluxClient.completeTask).toHaveBeenCalledWith(
      "task-1",
      "session-1",
      expect.objectContaining({
        status: "failed",
        output: "Runner claim response missing packet payload",
      }),
    );
  });

  it("fails task when no execution backend can handle requested backend", async () => {
    const fluxClient = createFluxClientMock();
    const packet: McpTaskPacket = {
      task: { id: "task-1", type: "demo" },
      execution: { backend: "pi" },
      policy: { heartbeatRequired: false },
    };
    fluxClient.claimTask.mockResolvedValue({ sessionId: "session-1", packet });
    const executor = makeExecutor(fluxClient, [makeBackend({ canExecute: () => false })]);

    await executor.claimAndExecuteTask("task-1");

    expect(fluxClient.completeTask).toHaveBeenCalledWith(
      "task-1",
      "session-1",
      expect.objectContaining({
        status: "failed",
        output: "Runner does not support execution backend: pi",
      }),
    );
  });

  it("completes task with backend output", async () => {
    const fluxClient = createFluxClientMock();
    const packet: McpTaskPacket = {
      task: { id: "task-1", type: "demo" },
      execution: { backend: "claude-cli" },
      policy: { heartbeatRequired: false },
      prompt: { rendered: "Do a thing" },
    };
    fluxClient.claimTask.mockResolvedValue({ sessionId: "session-1", packet });
    const backend = makeBackend({
      canExecute: (name) => name === "claude-cli",
      execute: async () => ({ status: "done", output: "done output", tokensUsed: 12, costUsd: 0.01 }),
    });
    const executor = makeExecutor(fluxClient, [backend]);

    await executor.claimAndExecuteTask("task-1");

    expect(fluxClient.completeTask).toHaveBeenCalledWith(
      "task-1",
      "session-1",
      expect.objectContaining({
        status: "done",
        output: "done output",
        tokensUsed: 12,
        costUsd: 0.01,
      }),
    );
    expect(fluxClient.heartbeat).not.toHaveBeenCalled();
  });

  it("marks task cancelled when heartbeat requests abort", async () => {
    vi.useFakeTimers();
    try {
      const fluxClient = createFluxClientMock();
      const packet: McpTaskPacket = {
        task: { id: "task-1", type: "demo" },
        execution: { backend: "claude-cli" },
      };
      fluxClient.claimTask.mockResolvedValue({ sessionId: "session-1", packet });
      fluxClient.heartbeat.mockResolvedValue({ shouldAbort: true, cancelPending: true });
      const backend = makeBackend({
        canExecute: () => true,
        execute: async ({ abortSignal }) => {
          await new Promise<void>((resolve) => {
            if (abortSignal.aborted) {
              resolve();
              return;
            }
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { status: "done", output: "ignored" };
        },
      });
      const executor = makeExecutor(fluxClient, [backend]);

      const running = executor.claimAndExecuteTask("task-1");
      await vi.advanceTimersByTimeAsync(10_000);
      await running;

      expect(fluxClient.heartbeat).toHaveBeenCalled();
      expect(fluxClient.completeTask).toHaveBeenCalledWith(
        "task-1",
        "session-1",
        expect.objectContaining({
          status: "cancelled",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates OpenClaw approval errors", async () => {
    const fluxClient = createFluxClientMock();
    const packet: McpTaskPacket = {
      task: { id: "task-1", type: "demo" },
      execution: { backend: "claude-cli" },
      policy: { heartbeatRequired: false },
    };
    fluxClient.claimTask.mockResolvedValue({ sessionId: "session-1", packet });
    const backend = makeBackend({
      id: "openclaw",
      canExecute: () => true,
      execute: async () => {
        throw new Error("execution requires approval");
      },
    });
    const executor = makeExecutor(fluxClient, [backend]);

    await executor.claimAndExecuteTask("task-1");

    expect(fluxClient.completeTask).toHaveBeenCalledWith(
      "task-1",
      "session-1",
      expect.objectContaining({ status: "failed" }),
    );
    expect(fluxClient.escalateTask).toHaveBeenCalledWith(
      "task-1",
      "session-1",
      "OpenClaw approval required",
      "Approve the pending execution and retry task",
    );
  });

  it("claimAndExecuteFromPacket no-ops when packet has no id", async () => {
    const fluxClient = createFluxClientMock();
    const executor = makeExecutor(fluxClient, [makeBackend()]);

    await executor.claimAndExecuteFromPacket({ type: "demo" });

    expect(fluxClient.claimTask).not.toHaveBeenCalled();
  });
});
