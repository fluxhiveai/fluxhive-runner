import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CadenceLoop } from "../../src/runner/cadence.ts";
import type { McpTaskPacket, McpTaskListResponse } from "../../src/types.ts";

type FluxClientMock = {
  listTasks: ReturnType<typeof vi.fn>;
};

type ExecutorMock = {
  claimAndExecuteFromPacket: ReturnType<typeof vi.fn>;
};

function createClientMock(): FluxClientMock {
  return {
    listTasks: vi.fn(),
  };
}

function createExecutorMock(): ExecutorMock {
  return {
    claimAndExecuteFromPacket: vi.fn().mockResolvedValue(undefined),
  };
}

function makeLoop(
  client: FluxClientMock,
  executor: ExecutorMock,
  overrides: {
    intervalMs?: number;
    listLimit?: number;
    streamId?: string;
    backend?: string;
    costClass?: string;
    onError?: (error: unknown) => void;
  } = {},
): CadenceLoop {
  return new CadenceLoop({
    client: client as never,
    executor: executor as never,
    intervalMs: overrides.intervalMs ?? 60_000,
    listLimit: overrides.listLimit,
    streamId: overrides.streamId,
    backend: overrides.backend,
    costClass: overrides.costClass,
    onError: overrides.onError,
  });
}

function makeTasks(count: number): McpTaskPacket[] {
  return Array.from({ length: count }, (_, i) => ({
    taskId: `task-${i}`,
    type: "demo",
    task: { id: `task-${i}`, type: "demo" },
  }));
}

describe("CadenceLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // drainOnce (tested through start + tick)
  // ---------------------------------------------------------------------------

  it("processes all tasks from a single list page", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();
    const tasks = makeTasks(3);

    // First call returns 3 tasks (less than limit of 10), second is not needed
    client.listTasks.mockResolvedValueOnce({ tasks } satisfies McpTaskListResponse);

    const loop = makeLoop(client, executor);
    loop.start();

    // Let the initial tick run
    await vi.advanceTimersByTimeAsync(0);

    // Wait for async drain to complete
    await vi.advanceTimersByTimeAsync(0);

    expect(executor.claimAndExecuteFromPacket).toHaveBeenCalledTimes(3);
    expect(executor.claimAndExecuteFromPacket).toHaveBeenCalledWith(tasks[0]);
    expect(executor.claimAndExecuteFromPacket).toHaveBeenCalledWith(tasks[1]);
    expect(executor.claimAndExecuteFromPacket).toHaveBeenCalledWith(tasks[2]);

    loop.stop();
  });

  it("pages through results until fewer than limit returned", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();

    // Use listLimit of 2
    // Page 1: 2 tasks (== limit, fetch again)
    // Page 2: 1 task (< limit, stop)
    client.listTasks
      .mockResolvedValueOnce({ tasks: makeTasks(2) })
      .mockResolvedValueOnce({ tasks: [{ taskId: "task-extra", task: { id: "task-extra", type: "demo" } }] });

    const loop = makeLoop(client, executor, { listLimit: 2 });
    loop.start();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.listTasks).toHaveBeenCalledTimes(2);
    expect(executor.claimAndExecuteFromPacket).toHaveBeenCalledTimes(3);

    loop.stop();
  });

  it("handles empty list without calling executor", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();
    client.listTasks.mockResolvedValueOnce({ tasks: [] });

    const loop = makeLoop(client, executor);
    loop.start();

    await vi.advanceTimersByTimeAsync(0);

    expect(executor.claimAndExecuteFromPacket).not.toHaveBeenCalled();

    loop.stop();
  });

  it("handles response with non-array tasks field gracefully", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();
    // tasks is not an array
    client.listTasks.mockResolvedValueOnce({ tasks: "invalid" });

    const loop = makeLoop(client, executor);
    loop.start();

    await vi.advanceTimersByTimeAsync(0);

    expect(executor.claimAndExecuteFromPacket).not.toHaveBeenCalled();

    loop.stop();
  });

  // ---------------------------------------------------------------------------
  // start / stop
  // ---------------------------------------------------------------------------

  it("start() triggers an immediate tick", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();
    client.listTasks.mockResolvedValue({ tasks: [] });

    const loop = makeLoop(client, executor);
    loop.start();

    await vi.advanceTimersByTimeAsync(0);

    expect(client.listTasks).toHaveBeenCalledTimes(1);

    loop.stop();
  });

  it("start() is idempotent — calling twice does not double tick", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();
    client.listTasks.mockResolvedValue({ tasks: [] });

    const loop = makeLoop(client, executor);
    loop.start();
    loop.start();

    await vi.advanceTimersByTimeAsync(0);

    // Only one interval timer should be created
    expect(client.listTasks).toHaveBeenCalledTimes(1);

    loop.stop();
  });

  it("stop() clears interval and prevents future ticks", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();
    client.listTasks.mockResolvedValue({ tasks: [] });

    const loop = makeLoop(client, executor, { intervalMs: 5_000 });
    loop.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(client.listTasks).toHaveBeenCalledTimes(1);

    loop.stop();

    // Advance past several intervals — no more ticks should fire
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.listTasks).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // triggerNow
  // ---------------------------------------------------------------------------

  it("triggerNow() forces immediate re-run", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();
    client.listTasks.mockResolvedValue({ tasks: [] });

    const loop = makeLoop(client, executor, { intervalMs: 60_000 });
    loop.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(client.listTasks).toHaveBeenCalledTimes(1);

    loop.triggerNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.listTasks).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  it("triggerNow() is no-op when not running", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();
    client.listTasks.mockResolvedValue({ tasks: [] });

    const loop = makeLoop(client, executor);
    // Don't start — just triggerNow
    loop.triggerNow();

    await vi.advanceTimersByTimeAsync(0);
    expect(client.listTasks).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Concurrent tick guard
  // ---------------------------------------------------------------------------

  it("does not overlap ticks — queues a rerun request instead", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();

    // The first listTasks call takes a while
    let resolveFirst: (() => void) | null = null;
    const firstCall = new Promise<McpTaskListResponse>((resolve) => {
      resolveFirst = () => resolve({ tasks: [] });
    });
    client.listTasks.mockReturnValueOnce(firstCall);
    client.listTasks.mockResolvedValue({ tasks: [] });

    const loop = makeLoop(client, executor, { intervalMs: 1_000 });
    loop.start();

    // The first tick is in-flight (waiting on firstCall)
    await vi.advanceTimersByTimeAsync(0);
    expect(client.listTasks).toHaveBeenCalledTimes(1);

    // Interval fires while first tick is still in-flight
    await vi.advanceTimersByTimeAsync(1_000);
    // Tick should NOT start a second listTasks yet (guard)
    expect(client.listTasks).toHaveBeenCalledTimes(1);

    // Resolve the first tick
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Now the rerun should have fired
    expect(client.listTasks).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  // ---------------------------------------------------------------------------
  // Error callback
  // ---------------------------------------------------------------------------

  it("calls onError when drainOnce throws", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();
    const onError = vi.fn();

    const listError = new Error("Network failure");
    client.listTasks.mockRejectedValueOnce(listError);
    client.listTasks.mockResolvedValue({ tasks: [] });

    const loop = makeLoop(client, executor, { onError });
    loop.start();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(listError);

    loop.stop();
  });

  // ---------------------------------------------------------------------------
  // listTasks call parameters
  // ---------------------------------------------------------------------------

  it("passes streamId, backend, and costClass to listTasks", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();
    client.listTasks.mockResolvedValue({ tasks: [] });

    const loop = makeLoop(client, executor, {
      streamId: "s-1",
      backend: "claude-cli",
      costClass: "premium",
    });
    loop.start();

    await vi.advanceTimersByTimeAsync(0);

    expect(client.listTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "todo",
        mode: "compact",
        format: "packet",
        streamId: "s-1",
        backend: "claude-cli",
        costClass: "premium",
      }),
    );

    loop.stop();
  });

  it("uses default listLimit of 10", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();
    client.listTasks.mockResolvedValue({ tasks: [] });

    const loop = makeLoop(client, executor);
    loop.start();

    await vi.advanceTimersByTimeAsync(0);

    expect(client.listTasks).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
    );

    loop.stop();
  });

  it("clamps listLimit to minimum of 1", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();
    client.listTasks.mockResolvedValue({ tasks: [] });

    const loop = makeLoop(client, executor, { listLimit: -5 });
    loop.start();

    await vi.advanceTimersByTimeAsync(0);

    expect(client.listTasks).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
    );

    loop.stop();
  });

  // ---------------------------------------------------------------------------
  // Interval behavior
  // ---------------------------------------------------------------------------

  it("fires periodic ticks based on intervalMs", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();
    client.listTasks.mockResolvedValue({ tasks: [] });

    const loop = makeLoop(client, executor, { intervalMs: 5_000 });
    loop.start();

    await vi.advanceTimersByTimeAsync(0); // Initial tick
    expect(client.listTasks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000); // Second tick
    expect(client.listTasks).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_000); // Third tick
    expect(client.listTasks).toHaveBeenCalledTimes(3);

    loop.stop();
  });

  it("enforces minimum 1000ms interval", async () => {
    const client = createClientMock();
    const executor = createExecutorMock();
    client.listTasks.mockResolvedValue({ tasks: [] });

    // intervalMs of 100 should be clamped to 1000 by setInterval(Math.max(1_000, ...))
    const loop = makeLoop(client, executor, { intervalMs: 100 });
    loop.start();

    await vi.advanceTimersByTimeAsync(0); // Initial
    expect(client.listTasks).toHaveBeenCalledTimes(1);

    // 500ms — too soon
    await vi.advanceTimersByTimeAsync(500);
    expect(client.listTasks).toHaveBeenCalledTimes(1);

    // 1000ms total — should fire
    await vi.advanceTimersByTimeAsync(500);
    expect(client.listTasks).toHaveBeenCalledTimes(2);

    loop.stop();
  });
});
