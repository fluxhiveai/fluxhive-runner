import type { ConvexClient } from "convex/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentResolutionError,
  createAndAwaitTask,
  SkillDisabledError,
  SkillNotFoundError,
  TaskFailedError,
  TaskTimeoutError,
} from "./create-and-await-task.js";

const mockMutation = vi.fn();
const mockQuery = vi.fn();

vi.mock("../core/convex-client.js", () => ({
  api: {
    skills: { getByName: "skills.getByName" },
    agents: { list: "agents.list" },
    tasks: { create: "tasks.create", get: "tasks.get" },
  },
}));

function createMockClient(): ConvexClient {
  return {
    mutation: mockMutation,
    query: mockQuery,
  } as unknown as ConvexClient;
}

describe("create-and-await-task", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when job is missing", async () => {
    mockQuery.mockImplementation((endpoint: string) => {
      if (endpoint === "skills.getByName") {
        return null;
      }
      return null;
    });

    await expect(
      createAndAwaitTask({
        client: createMockClient(),
        squadId: "squad-1",
        skillName: "writer",
        input: { topic: "cats" },
      }),
    ).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it("throws when job is disabled", async () => {
    mockQuery.mockImplementation((endpoint: string) => {
      if (endpoint === "skills.getByName") {
        return {
          _id: "skills:1",
          name: "writer",
          type: "execution",
          enabled: false,
          capableRoles: ["Writer"],
        };
      }
      return null;
    });

    await expect(
      createAndAwaitTask({
        client: createMockClient(),
        squadId: "squad-1",
        skillName: "writer",
        input: { topic: "cats" },
      }),
    ).rejects.toBeInstanceOf(SkillDisabledError);
  });

  it("throws when requireAgent is true and no agent matches", async () => {
    mockQuery.mockImplementation((endpoint: string) => {
      if (endpoint === "skills.getByName") {
        return {
          _id: "skills:1",
          name: "writer",
          type: "execution",
          enabled: true,
          capableRoles: ["Writer"],
        };
      }
      if (endpoint === "agents.list") {
        return [{ _id: "agent-1", name: "Researcher" }];
      }
      return null;
    });

    await expect(
      createAndAwaitTask({
        client: createMockClient(),
        squadId: "squad-1",
        skillName: "writer",
        input: { topic: "cats" },
        requireAgent: true,
      }),
    ).rejects.toBeInstanceOf(AgentResolutionError);
  });

  it("creates a task and returns output on done", async () => {
    mockQuery.mockImplementation((endpoint: string, args?: { id?: string }) => {
      if (endpoint === "skills.getByName") {
        return {
          _id: "skills:1",
          name: "writer",
          type: "execution",
          enabled: true,
          capableRoles: ["Writer"],
        };
      }
      if (endpoint === "agents.list") {
        return [{ _id: "agent-1", name: "Writer" }];
      }
      if (endpoint === "tasks.get" && args?.id === "task-1") {
        return { _id: "task-1", status: "done", output: "ready" };
      }
      return null;
    });
    mockMutation.mockResolvedValue("task-1");

    const result = await createAndAwaitTask({
      client: createMockClient(),
      squadId: "squad-1",
      skillName: "writer",
      input: { topic: "cats" },
      goal: "Write cat post",
    });

    expect(result).toEqual({
      taskId: "task-1",
      status: "done",
      output: "ready",
    });
    expect(mockMutation).toHaveBeenCalledWith("tasks.create", {
      squadId: "squad-1",
      skillId: "skills:1",
      type: "writer",
      goal: "Write cat post",
      input: JSON.stringify({ topic: "cats" }),
      source: "run",
      agentId: "agent-1",
    });
  });

  it("passes runId through to task creation", async () => {
    mockQuery.mockImplementation((endpoint: string, args?: { id?: string }) => {
      if (endpoint === "skills.getByName") {
        return {
          _id: "skills:1",
          name: "writer",
          type: "execution",
          enabled: true,
          capableRoles: ["Writer"],
        };
      }
      if (endpoint === "agents.list") {
        return [{ _id: "agent-1", name: "Writer" }];
      }
      if (endpoint === "tasks.get" && args?.id === "task-1") {
        return { _id: "task-1", status: "done", output: "ready" };
      }
      return null;
    });
    mockMutation.mockResolvedValue("task-1");

    await createAndAwaitTask({
      client: createMockClient(),
      squadId: "squad-1",
      skillName: "writer",
      input: { topic: "cats" },
      runId: "runs:1",
    });

    expect(mockMutation).toHaveBeenCalledWith("tasks.create", {
      squadId: "squad-1",
      skillId: "skills:1",
      type: "writer",
      goal: "[Run] writer",
      input: JSON.stringify({ topic: "cats" }),
      source: "run",
      agentId: "agent-1",
      runId: "runs:1",
    });
  });

  it("throws when task fails", async () => {
    mockQuery.mockImplementation((endpoint: string, args?: { id?: string }) => {
      if (endpoint === "skills.getByName") {
        return {
          _id: "skills:1",
          name: "writer",
          type: "execution",
          enabled: true,
          capableRoles: [],
        };
      }
      if (endpoint === "agents.list") {
        return [];
      }
      if (endpoint === "tasks.get" && args?.id === "task-1") {
        return { _id: "task-1", status: "failed", output: "boom" };
      }
      return null;
    });
    mockMutation.mockResolvedValue("task-1");

    await expect(
      createAndAwaitTask({
        client: createMockClient(),
        squadId: "squad-1",
        skillName: "writer",
        input: { topic: "cats" },
      }),
    ).rejects.toBeInstanceOf(TaskFailedError);
  });

  it("throws timeout when task does not complete in time", async () => {
    mockQuery.mockImplementation((endpoint: string) => {
      if (endpoint === "skills.getByName") {
        return {
          _id: "skills:1",
          name: "writer",
          type: "execution",
          enabled: true,
          capableRoles: [],
        };
      }
      if (endpoint === "agents.list") {
        return [];
      }
      if (endpoint === "tasks.get") {
        return { _id: "task-1", status: "doing", output: "" };
      }
      return null;
    });
    mockMutation.mockResolvedValue("task-1");

    let now = 0;
    await expect(
      createAndAwaitTask({
        client: createMockClient(),
        squadId: "squad-1",
        skillName: "writer",
        input: { topic: "cats" },
        timeoutMs: 20,
        pollIntervalMs: 10,
        hooks: {
          now: () => now,
          sleep: async (ms: number) => {
            now += ms;
          },
        },
      }),
    ).rejects.toBeInstanceOf(TaskTimeoutError);
  });
});
