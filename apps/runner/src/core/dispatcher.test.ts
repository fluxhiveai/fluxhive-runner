import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "./types.js";

const mockMutation = vi.fn();
const mockQuery = vi.fn();
const mockSpawn = vi.fn();
const mockCallGateway = vi.fn();
const mockResolveExecutionCwdForTask = vi.fn();
const mockBuildPromptFromSkillTemplate = vi.fn();
const mockBuildPromptFromTemplate = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "test-uuid-1234-5678-abcd",
}));

vi.mock("./agent-spawn.js", () => ({
  resolveCliBin: () => ({ command: "openclaw", prefixArgs: [] }),
  resolveClaudeBin: () => ({ command: "claude", prefixArgs: [] }),
  buildClaudeArgs: () => ["-p", "prompt", "--output-format", "json"],
  buildPromptFromTemplate: (...args: unknown[]) => mockBuildPromptFromTemplate(...args),
  buildPromptFromSkillTemplate: (...args: unknown[]) => mockBuildPromptFromSkillTemplate(...args),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => mockCallGateway(...args),
  randomIdempotencyKey: () => "idem-key-1234",
}));

vi.mock("./repo-workspace.js", () => ({
  resolveExecutionCwdForTask: (...args: unknown[]) => mockResolveExecutionCwdForTask(...args),
}));

vi.mock("./convex-client.js", () => ({
  api: {
    agentSessions: {
      startRun: "agentSessions.startRun",
      updateStatus: "agentSessions.updateStatus",
    },
    tasks: {
      updateStatus: "tasks.updateStatus",
      getExecutionRepoContext: "tasks.getExecutionRepoContext",
      list: "tasks.list",
    },
    events: {
      create: "events.create",
    },
    task_outputs_archive: {
      archive: "task_outputs_archive.archive",
    },
    llmLogs: {
      create: "llmLogs.create",
    },
    skills: {
      get: "skills.get",
    },
    streams: {
      get: "streams.get",
      list: "streams.list",
    },
    runs: {
      countByStatus: "runs.countByStatus",
      get: "runs.get",
    },
    run_events: {
      getLatest: "run_events.getLatest",
    },
    memory_kv: {
      get: "memory_kv.get",
    },
    chat: {
      storeResponse: "chat.storeResponse",
      completeChatResponse: "chat.completeChatResponse",
      listMessages: "chat.listMessages",
    },
    goals: {
      get: "goals.get",
    },
    agents: {
      get: "agents.get",
      getByName: "agents.getByName",
      list: "agents.list",
    },
    admin: {
      getValue: "admin.getValue",
    },
  },
}));

vi.mock("../../logging/subsystem.js", () => {
  const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { createSubsystemLogger: () => noopLogger };
});

vi.mock("./flux-log.js", () => ({
  appendFluxLog: vi.fn(),
}));

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    _id: "task-1",
    _creationTime: Date.now(),
    streamId: "streams:1",
    goal: "Fix bug",
    type: "dev",
    status: "todo",
    input: JSON.stringify({ issueNumber: "42", title: "Fix bug" }),
    source: "github",
    skillId: "skills:dev",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("dispatcher", () => {
  let dispatchTask: typeof import("./dispatcher.js").dispatchTask;
  let getActiveSessionCount: typeof import("./dispatcher.js").getActiveSessionCount;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.SQUAD_DASHBOARD_CHAT_AGENT;

    mockBuildPromptFromSkillTemplate.mockResolvedValue("built prompt");
    mockBuildPromptFromTemplate.mockReturnValue("chat prompt");
    mockResolveExecutionCwdForTask.mockResolvedValue({ cwd: undefined, repoContext: null });
    mockMutation.mockResolvedValue("convex-session-id-1");

    mockQuery.mockImplementation((endpoint: string) => {
      if (endpoint === "skills.get") {
        return {
          _id: "skills:dev",
          name: "dev",
          enabled: true,
          promptTemplate: "Do work",
          executionMode: "openclaw-agent",
        };
      }
      if (endpoint === "streams.list") {
        return [];
      }
      if (endpoint === "runs.countByStatus") {
        return { total: 0, byStatus: {} };
      }
      if (endpoint === "run_events.getLatest") {
        return [];
      }
      if (endpoint === "memory_kv.get") {
        return null;
      }
      if (endpoint === "tasks.list") {
        return [];
      }
      if (endpoint === "chat.listMessages") {
        return [];
      }
      return null;
    });

    vi.resetModules();
    const mod = await import("./dispatcher.js");
    dispatchTask = mod.dispatchTask;
    getActiveSessionCount = mod.getActiveSessionCount;
  });

  afterEach(() => {
    delete process.env.SQUAD_DASHBOARD_CHAT_AGENT;
  });

  it("dispatches and completes a standard task", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const client = { mutation: mockMutation, query: mockQuery } as unknown as import("convex/browser").ConvexClient;
    const result = await dispatchTask(createTask(), client);

    child.stdout.emit("data", Buffer.from("done output"));
    child.emit("close", 0);

    const outcome = await result.promise;
    expect(outcome).toEqual({ ok: true, output: "done output" });

    expect(mockMutation).toHaveBeenCalledWith("agentSessions.startRun", {
      taskId: "task-1",
      sessionId: "test-uuid-1234-5678-abcd",
      model: undefined,
    });
    expect(mockMutation).toHaveBeenCalledWith("tasks.updateStatus", {
      id: "task-1",
      status: "doing",
    });
    expect(mockMutation).toHaveBeenCalledWith(
      "tasks.updateStatus",
      expect.objectContaining({ id: "task-1", status: "done", output: "done output" }),
    );
    expect(mockMutation).toHaveBeenCalledWith("agentSessions.updateStatus", {
      id: "convex-session-id-1",
      status: "idle",
    });
    expect(mockMutation).toHaveBeenCalledWith(
      "events.create",
      expect.objectContaining({ taskId: "task-1", type: "result", fromAgent: "dev" }),
    );
    expect(mockMutation).toHaveBeenCalledWith(
      "task_outputs_archive.archive",
      expect.objectContaining({ taskId: "task-1", taskType: "dev" }),
    );
  });

  it("handles subprocess spawn error", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const client = { mutation: mockMutation, query: mockQuery } as unknown as import("convex/browser").ConvexClient;
    const result = await dispatchTask(createTask(), client);

    child.emit("error", new Error("spawn failed"));
    const outcome = await result.promise;

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain("spawn failed");
    expect(mockMutation).toHaveBeenCalledWith(
      "tasks.updateStatus",
      expect.objectContaining({ id: "task-1", status: "failed" }),
    );
  });

  it("routes conductor-chat through gateway", async () => {
    mockQuery.mockImplementation((endpoint: string) => {
      if (endpoint === "skills.get") {
        return {
          _id: "skills:chat",
          name: "chat",
          enabled: true,
          promptTemplate: "Respond to chat",
          executionMode: "gateway",
        };
      }
      if (endpoint === "streams.get") {
        return { name: "Main Stream", slug: "main" };
      }
      if (endpoint === "streams.list") {
        return [];
      }
      if (endpoint === "runs.countByStatus") {
        return { total: 0, byStatus: {} };
      }
      if (endpoint === "tasks.list") {
        return [];
      }
      if (endpoint === "chat.listMessages") {
        return [];
      }
      if (endpoint === "memory_kv.get") {
        return null;
      }
      return null;
    });

    mockCallGateway.mockResolvedValue({
      status: "ok",
      result: { payloads: [{ text: '{"message":"hello"}' }] },
    });

    const task = createTask({
      _id: "task-chat-1",
      type: "conductor-chat",
      skillId: "skills:chat",
      input: JSON.stringify({ message: "hi", assistantMessageId: "chat_messages:1" }),
    });

    const client = { mutation: mockMutation, query: mockQuery } as unknown as import("convex/browser").ConvexClient;
    const result = await dispatchTask(task, client);
    const outcome = await result.promise;

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toContain("message");
    expect(mockCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "agent", expectFinal: true }),
    );
  });

  it("uses main agent for conductor-chat even when leader mode is requested", async () => {
    process.env.SQUAD_DASHBOARD_CHAT_AGENT = "leader";

    mockQuery.mockImplementation((endpoint: string) => {
      if (endpoint === "skills.get") {
        return {
          _id: "skills:chat",
          name: "chat",
          enabled: true,
          promptTemplate: "Respond to chat",
          executionMode: "gateway",
        };
      }
      if (endpoint === "streams.get") {
        return { slug: "main", leaderAgentId: "agents:leader-1" };
      }
      if (endpoint === "agents.get") {
        return { _id: "agents:leader-1", name: "NEXUS", openclawAgentId: "vault-leader" };
      }
      if (endpoint === "streams.list") {
        return [];
      }
      if (endpoint === "runs.countByStatus") {
        return { total: 0, byStatus: {} };
      }
      if (endpoint === "tasks.list") {
        return [];
      }
      if (endpoint === "chat.listMessages") {
        return [];
      }
      if (endpoint === "memory_kv.get") {
        return null;
      }
      return null;
    });

    mockCallGateway.mockResolvedValue({
      status: "ok",
      result: { payloads: [{ text: "leader reply" }] },
    });

    const task = createTask({
      _id: "task-chat-2",
      type: "conductor-chat",
      skillId: "skills:chat",
      input: JSON.stringify({ message: "route me" }),
    });

    const client = { mutation: mockMutation, query: mockQuery } as unknown as import("convex/browser").ConvexClient;
    const result = await dispatchTask(task, client);
    await result.promise;

    const gatewayCall = mockCallGateway.mock.calls[0]?.[0] as Record<string, unknown>;
    const params = gatewayCall.params as Record<string, unknown>;
    expect(params.agentId).toBe("main");
    expect(params.sessionKey).toBe("agent:main:main");
  });

  it("tracks active session count", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const client = { mutation: mockMutation, query: mockQuery } as unknown as import("convex/browser").ConvexClient;
    const result = await dispatchTask(createTask(), client);
    expect(getActiveSessionCount()).toBe(1);

    child.emit("close", 0);
    await result.promise;

    expect(getActiveSessionCount()).toBe(0);
  });
});
