import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "./types.js";
import { createSupervisor } from "./supervisor.js";

// --- Dispatcher mocks ---

const dispatchTaskMock = vi.fn();

vi.mock("./dispatcher.js", () => ({
  dispatchTask: (...args: unknown[]) => dispatchTaskMock(...args),
  createDispatchContext: () => ({
    activeSessions: new Map(),
    pendingDispatch: new Set(),
  }),
}));

// --- Convex API mock ---

vi.mock("./convex-client.js", () => ({
  api: {
    tasks: { countByStatus: "tasks:countByStatus", getReady: "tasks:getReady" },
    admin: { setValue: "admin:setValue", setSquadState: "admin:setSquadState" },
    squads: { list: "squads:list" },
  },
}));

// --- Logger mock ---

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
}));

// --- Helpers ---

const unsubscribeMock = vi.fn();

function createMockClient() {
  return {
    query: vi.fn(),
    mutation: vi.fn(),
    onUpdate: vi.fn().mockReturnValue(unsubscribeMock),
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    _id: "task-1",
    _creationTime: Date.now(),
    squadId: "squad-1",
    goal: "Fix bug",
    type: "groomer",
    status: "todo",
    input: "{}",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// --- Tests ---

describe("createSupervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();

    dispatchTaskMock.mockReset();
    unsubscribeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("start/stop lifecycle", () => {
    it("subscribes to tasks and sets running state on start", async () => {
      const client = createMockClient();
      client.mutation.mockResolvedValue(undefined);

      const supervisor = createSupervisor(client as never);
      await supervisor.start();

      expect(client.onUpdate).toHaveBeenCalledTimes(1);
      expect(client.onUpdate).toHaveBeenCalledWith("tasks:getReady", {}, expect.any(Function));
    });

    it("is idempotent on double start", async () => {
      const client = createMockClient();
      client.mutation.mockResolvedValue(undefined);

      const supervisor = createSupervisor(client as never);
      await supervisor.start();
      await supervisor.start();

      expect(client.onUpdate).toHaveBeenCalledTimes(1);
    });

    it("cleans up on stop", async () => {
      const client = createMockClient();
      client.mutation.mockResolvedValue(undefined);

      const supervisor = createSupervisor(client as never);
      await supervisor.start();
      await supervisor.stop();

      expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    });

    it("is idempotent on double stop", async () => {
      const client = createMockClient();
      client.mutation.mockResolvedValue(undefined);

      const supervisor = createSupervisor(client as never);
      await supervisor.start();
      await supervisor.stop();
      await supervisor.stop();

      // Only one unsubscribe
      expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    });

    it("kills active sessions on stop", async () => {
      const client = createMockClient();
      client.mutation.mockResolvedValue(undefined);
      client.query.mockResolvedValue({ review: 0, doing: 0, todo: 2 });

      const killMock1 = vi.fn();
      const killMock2 = vi.fn();
      const killMocks = [killMock1, killMock2];
      let callIdx = 0;
      // dispatchTask populates the context and returns sessions with kill()
      dispatchTaskMock.mockImplementation(
        (_task: Task, _client: unknown, ctx: { activeSessions: Map<string, unknown> }) => {
          const kill = killMocks[callIdx++];
          ctx.activeSessions.set(_task._id, { kill });
          return Promise.resolve({
            promise: new Promise(() => {}), // never resolves
            kill,
          });
        },
      );

      const supervisor = createSupervisor(client as never, {
        maxConcurrent: 4,
      });
      await supervisor.start();

      // Dispatch two tasks to populate activeSessions
      const onReady = client.onUpdate.mock.calls[0][2] as (tasks: Task[]) => void;
      onReady([makeTask({ _id: "task-1" }), makeTask({ _id: "task-2" })]);
      await vi.advanceTimersByTimeAsync(0);

      expect(dispatchTaskMock).toHaveBeenCalledTimes(2);

      await supervisor.stop();

      expect(killMock1).toHaveBeenCalledTimes(1);
      expect(killMock2).toHaveBeenCalledTimes(1);
    });
  });

  describe("WIP limits", () => {
    it("dispatches when under WIP limit", async () => {
      const client = createMockClient();
      client.mutation.mockResolvedValue(undefined);
      client.query.mockResolvedValue({ review: 0, doing: 0, todo: 1 });

      const task = makeTask();
      dispatchTaskMock.mockResolvedValue({
        promise: Promise.resolve({ ok: true }),
        kill: vi.fn(),
      });

      const supervisor = createSupervisor(client as never, {
        maxConcurrent: 2,
      });
      await supervisor.start();

      const onReadyCallback = client.onUpdate.mock.calls[0][2] as (tasks: Task[]) => Promise<void>;
      await onReadyCallback([task]);

      expect(dispatchTaskMock).toHaveBeenCalledTimes(1);
      expect(dispatchTaskMock).toHaveBeenCalledWith(task, client, expect.any(Object));
    });

    it("stops dispatching at WIP limit", async () => {
      const client = createMockClient();
      client.mutation.mockResolvedValue(undefined);
      client.query.mockResolvedValue({ review: 0, doing: 1, todo: 2 });

      const task1 = makeTask({ _id: "task-1" });
      const task2 = makeTask({ _id: "task-2" });

      // After the first dispatch, populate the dispatchCtx to simulate WIP
      dispatchTaskMock.mockImplementation(
        (_task: Task, _client: unknown, ctx: { activeSessions: Map<string, unknown> }) => {
          ctx.activeSessions.set(_task._id, { kill: vi.fn() });
          return Promise.resolve({
            promise: Promise.resolve({ ok: true }),
            kill: vi.fn(),
          });
        },
      );

      const supervisor = createSupervisor(client as never, {
        maxConcurrent: 1,
      });
      await supervisor.start();

      const onReadyCallback = client.onUpdate.mock.calls[0][2] as (tasks: Task[]) => Promise<void>;
      await onReadyCallback([task1, task2]);

      expect(dispatchTaskMock).toHaveBeenCalledTimes(1);
      expect(dispatchTaskMock).toHaveBeenCalledWith(task1, client, expect.any(Object));
    });
  });

  describe("review queue cap", () => {
    it("pauses when review count >= cap", async () => {
      const client = createMockClient();
      client.mutation.mockResolvedValue(undefined);
      client.query.mockResolvedValue({ review: 5, doing: 0, todo: 1 });

      const task = makeTask();

      const supervisor = createSupervisor(client as never, {
        maxPendingReview: 5,
      });
      await supervisor.start();

      const onReadyCallback = client.onUpdate.mock.calls[0][2] as (tasks: Task[]) => Promise<void>;
      await onReadyCallback([task]);

      // Should NOT dispatch any tasks
      expect(dispatchTaskMock).not.toHaveBeenCalled();
    });
  });

  describe("auto-pause on failures", () => {
    it("pauses after N failures in 30 min", async () => {
      const client = createMockClient();
      client.mutation.mockResolvedValue(undefined);
      client.query.mockResolvedValue({ review: 0, doing: 0, todo: 3 });

      // dispatchTask throws to trigger recordFailure via the catch block.
      // Each thrown error records one failure for the task's type.
      dispatchTaskMock.mockRejectedValue(new Error("agent crashed"));

      const supervisor = createSupervisor(client as never, {
        autoPauseAfterNFails: 2,
        maxConcurrent: 4,
      });
      await supervisor.start();

      // The onUpdate callback wraps onReadyTasks with `void`, so it does not
      // return a Promise. We need to call onReadyTasks and flush microtasks.
      const wrappedCallback = client.onUpdate.mock.calls[0][2] as (tasks: Task[]) => void;

      // Provide 3 tasks of the same type. The for-loop dispatches task-a
      // (throws, records failure #1), then task-b (throws, records failure #2),
      // then before dispatching task-c it checks countRecentFailures and sees
      // 2 >= threshold, triggering auto-pause.
      const task1 = makeTask({ _id: "task-a", type: "builder" });
      const task2 = makeTask({ _id: "task-b", type: "builder" });
      const task3 = makeTask({ _id: "task-c", type: "builder" });

      wrappedCallback([task1, task2, task3]);
      // Flush all microtasks so onReadyTasks completes
      await vi.advanceTimersByTimeAsync(0);

      // The supervisor should be paused (internal state) — we can't check
      // setSquadState since it's no longer called, but we verify by checking
      // that after the first two failures the third task is not dispatched
      expect(dispatchTaskMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("auto-resume", () => {
    it("resumes when review count drops below cap on heartbeat", async () => {
      const client = createMockClient();
      client.mutation.mockResolvedValue(undefined);

      // First query: review queue full (triggers pause)
      client.query.mockResolvedValueOnce({ review: 5, doing: 0, todo: 1 });

      const supervisor = createSupervisor(client as never, {
        maxPendingReview: 5,
        heartbeatIntervalMs: 1_000,
      });
      await supervisor.start();

      // Trigger a ready-tasks callback to cause the review-queue pause
      const onReadyCallback = client.onUpdate.mock.calls[0][2] as (tasks: Task[]) => Promise<void>;
      const task = makeTask();
      await onReadyCallback([task]);

      // On next heartbeat, review count has dropped
      // Mock squads.list for cadence check (returns empty)
      client.query.mockImplementation((queryName: string) => {
        if (queryName === "squads:list") {
          return Promise.resolve([]);
        }
        return Promise.resolve({ review: 2, doing: 0, todo: 1 });
      });

      // Advance timer to trigger heartbeat
      vi.advanceTimersByTime(1_000);
      // Flush the async heartbeat
      await vi.advanceTimersByTimeAsync(0);

      // The supervisor should now be un-paused — we can verify by sending tasks again
      // Reset query mock
      client.query.mockResolvedValue({ review: 0, doing: 0, todo: 1 });
      dispatchTaskMock.mockResolvedValue({
        promise: Promise.resolve({ ok: true }),
        kill: vi.fn(),
      });

      const task2 = makeTask({ _id: "task-2" });
      await onReadyCallback([task2]);

      // This task should now be dispatched because we're no longer paused
      expect(dispatchTaskMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("re-check after task completion", () => {
    it("re-queries getReady when a dispatched task's promise resolves (WIP slot freed)", async () => {
      const client = createMockClient();
      client.mutation.mockResolvedValue(undefined);

      const task1 = makeTask({ _id: "task-1", type: "math" });
      const task2 = makeTask({ _id: "task-2", type: "haiku" });

      // Controllable promise for task1
      let resolveTask1!: (v: { ok: boolean }) => void;
      const task1Promise = new Promise<{ ok: boolean }>((r) => {
        resolveTask1 = r;
      });

      let callCount = 0;
      dispatchTaskMock.mockImplementation(
        (_task: Task, _client: unknown, ctx: { activeSessions: Map<string, unknown> }) => {
          callCount += 1;
          ctx.activeSessions.set(_task._id, { kill: vi.fn() });
          const promise = callCount === 1 ? task1Promise : Promise.resolve({ ok: true });
          return Promise.resolve({
            promise,
            kill: vi.fn(),
          });
        },
      );

      client.query.mockImplementation((queryName: string) => {
        if (queryName === "tasks:countByStatus") {
          return Promise.resolve({ review: 0, doing: 0, todo: 1 });
        }
        if (queryName === "tasks:getReady") {
          return Promise.resolve([task2]);
        }
        return Promise.resolve(null);
      });

      const supervisor = createSupervisor(client as never, {
        maxConcurrent: 1,
      });
      await supervisor.start();

      const onReady = client.onUpdate.mock.calls[0][2] as (tasks: Task[]) => void;
      onReady([task1, task2]);
      await vi.advanceTimersByTimeAsync(0);

      // Only task1 dispatched — WIP full
      expect(dispatchTaskMock).toHaveBeenCalledTimes(1);

      // Simulate task1 completion: the real dispatcher would remove from activeSessions
      // in the settle handler. We need to remove it from the context the mock received.
      const ctx = dispatchTaskMock.mock.calls[0][2] as { activeSessions: Map<string, unknown> };
      ctx.activeSessions.delete("task-1");
      resolveTask1({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // Should have re-queried getReady and dispatched task2
      const getReadyCalls = client.query.mock.calls.filter(
        (c: unknown[]) => c[0] === "tasks:getReady",
      );
      expect(getReadyCalls.length).toBeGreaterThanOrEqual(1);
      expect(dispatchTaskMock).toHaveBeenCalledTimes(2);
      expect(dispatchTaskMock).toHaveBeenCalledWith(task2, client, expect.any(Object));
    });

    it("re-checks when subscription fires during dispatch (pendingRecheck)", async () => {
      const client = createMockClient();
      client.mutation.mockResolvedValue(undefined);

      const task1 = makeTask({ _id: "task-1", type: "math" });
      const task2 = makeTask({ _id: "task-2", type: "haiku" });

      // First dispatchTask hangs to keep dispatching=true
      let resolveHangingDispatch!: (v: unknown) => void;
      let callCount = 0;
      dispatchTaskMock.mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          return new Promise((r) => {
            resolveHangingDispatch = r;
          });
        }
        return Promise.resolve({
          promise: new Promise(() => {}),
          kill: vi.fn(),
        });
      });

      client.query.mockImplementation((queryName: string) => {
        if (queryName === "tasks:countByStatus") {
          return Promise.resolve({ review: 0, doing: 0, todo: 1 });
        }
        if (queryName === "tasks:getReady") {
          return Promise.resolve([task2]);
        }
        return Promise.resolve(null);
      });

      const supervisor = createSupervisor(client as never, {
        maxConcurrent: 2,
      });
      await supervisor.start();

      const onReady = client.onUpdate.mock.calls[0][2] as (tasks: Task[]) => void;

      // Start dispatching task1 — hangs at await dispatchTask
      onReady([task1]);
      await vi.advanceTimersByTimeAsync(0);

      // While dispatching=true, subscription fires again — should be noted
      onReady([task2]);
      await vi.advanceTimersByTimeAsync(0);

      expect(dispatchTaskMock).toHaveBeenCalledTimes(1);

      // Resolve the hanging dispatch — finally block checks pendingRecheck
      resolveHangingDispatch({
        promise: new Promise(() => {}),
        kill: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // Should have re-checked and dispatched task2
      const getReadyCalls = client.query.mock.calls.filter(
        (c: unknown[]) => c[0] === "tasks:getReady",
      );
      expect(getReadyCalls.length).toBeGreaterThanOrEqual(1);
      expect(dispatchTaskMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("task filtering", () => {
    it("skips tasks already dispatching (pendingDispatch populated by prior dispatch)", async () => {
      const client = createMockClient();
      client.mutation.mockResolvedValue(undefined);
      client.query.mockResolvedValue({ review: 0, doing: 0, todo: 1 });

      // First dispatch adds task to pendingDispatch; second call for same task should be skipped
      dispatchTaskMock.mockImplementation(
        (_task: Task, _client: unknown, ctx: { pendingDispatch: Set<string> }) => {
          ctx.pendingDispatch.add(_task._id);
          return Promise.resolve({
            promise: new Promise(() => {}),
            kill: vi.fn(),
          });
        },
      );

      const supervisor = createSupervisor(client as never);
      await supervisor.start();

      const task = makeTask({ _id: "task-1" });
      const onReadyCallback = client.onUpdate.mock.calls[0][2] as (tasks: Task[]) => Promise<void>;
      // First call dispatches
      await onReadyCallback([task]);
      expect(dispatchTaskMock).toHaveBeenCalledTimes(1);

      // Second call with same task should skip (already in pendingDispatch)
      client.query.mockResolvedValue({ review: 0, doing: 0, todo: 1 });
      await onReadyCallback([task]);
      expect(dispatchTaskMock).toHaveBeenCalledTimes(1);
    });

    it("skips tasks with active sessions", async () => {
      const client = createMockClient();
      client.mutation.mockResolvedValue(undefined);
      client.query.mockResolvedValue({ review: 0, doing: 0, todo: 1 });

      // dispatchTask adds to activeSessions
      dispatchTaskMock.mockImplementation(
        (_task: Task, _client: unknown, ctx: { activeSessions: Map<string, unknown> }) => {
          ctx.activeSessions.set(_task._id, { kill: vi.fn() });
          return Promise.resolve({
            promise: new Promise(() => {}),
            kill: vi.fn(),
          });
        },
      );

      const task = makeTask({ _id: "task-1" });

      const supervisor = createSupervisor(client as never);
      await supervisor.start();

      const onReadyCallback = client.onUpdate.mock.calls[0][2] as (tasks: Task[]) => Promise<void>;
      // First call dispatches
      await onReadyCallback([task]);
      expect(dispatchTaskMock).toHaveBeenCalledTimes(1);

      // Second call with same task should skip (already in activeSessions)
      client.query.mockResolvedValue({ review: 0, doing: 0, todo: 1 });
      await onReadyCallback([task]);
      expect(dispatchTaskMock).toHaveBeenCalledTimes(1);
    });

    it("does nothing for empty task list", async () => {
      const client = createMockClient();
      client.mutation.mockResolvedValue(undefined);

      const supervisor = createSupervisor(client as never);
      await supervisor.start();

      const onReadyCallback = client.onUpdate.mock.calls[0][2] as (tasks: Task[]) => Promise<void>;
      await onReadyCallback([]);

      // No query or dispatch calls
      expect(client.query).not.toHaveBeenCalled();
      expect(dispatchTaskMock).not.toHaveBeenCalled();
    });
  });
});
