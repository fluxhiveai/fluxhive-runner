import type { ConvexClient } from "convex/browser";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../core/types.js";

const postIssueCommentMock = vi.fn();

vi.mock("../capabilities/github/provider-factory.js", () => ({
  createGitHubCapabilityProvider: vi.fn(() => ({
    providerName: "openclaw",
    listProjectIssuesByStatus: vi.fn(),
    postIssueComment: postIssueCommentMock,
  })),
}));

vi.mock("../core/convex-client.js", () => ({
  api: {
    integration_feedback: {
      listPending: "integration_feedback:listPending",
      processById: "integration_feedback:processById",
      markDeliveryFailure: "integration_feedback:markDeliveryFailure",
    },
    integrations: {
      get: "integrations:get",
    },
    tasks: {
      get: "tasks:get",
      getExecutionRepoContext: "tasks:getExecutionRepoContext",
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
  return {
    createSubsystemLogger: () => noopLogger,
  };
});

function createContext(): RuntimeContext {
  return {
    convexUrl: "https://test.convex.cloud",
  };
}

type MockClient = {
  client: ConvexClient;
  queryMock: ReturnType<typeof vi.fn>;
  mutationMock: ReturnType<typeof vi.fn>;
};

function createMockClient(mutationMock: ReturnType<typeof vi.fn>): MockClient {
  const queryMock = vi.fn(async (endpoint: string, args?: Record<string, unknown>) => {
    if (endpoint === "integration_feedback:listPending") {
      return [];
    }
    if (endpoint === "integrations:get") {
      return {
        _id: args?.id,
        type: "custom",
        enabled: true,
      };
    }
    if (endpoint === "tasks:get") {
      return null;
    }
    return null;
  });

  const client = {
    mutation: mutationMock,
    query: queryMock,
  } as unknown as ConvexClient;

  return {
    client,
    queryMock,
    mutationMock,
  };
}

describe("createIntegrationFeedbackWorker", () => {
  let createIntegrationFeedbackWorker: typeof import("./integration-feedback-worker.js").createIntegrationFeedbackWorker;

  beforeEach(async () => {
    vi.clearAllMocks();
    postIssueCommentMock.mockResolvedValue({ ok: true });
    vi.resetModules();
    const mod = await import("./integration-feedback-worker.js");
    createIntegrationFeedbackWorker = mod.createIntegrationFeedbackWorker;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("processes pending feedback events immediately on start", async () => {
    const mutationMock = vi.fn().mockResolvedValue({ status: "sent" });
    const { client, queryMock } = createMockClient(mutationMock);
    queryMock.mockImplementation(async (endpoint: string, args?: Record<string, unknown>) => {
      if (endpoint === "integration_feedback:listPending") {
        return [
          {
            _id: "integration_feedback_events:1",
            integrationId: "integrations:1",
            topic: "task",
            eventType: "task_status_changed",
            payloadJson: JSON.stringify({ status: "done" }),
          },
        ];
      }
      if (endpoint === "integrations:get") {
        return { _id: args?.id, type: "custom", enabled: true };
      }
      return null;
    });
    const worker = createIntegrationFeedbackWorker(client, { pollEveryMs: 60_000, batchLimit: 25 });

    await worker.start(createContext());
    await worker.stop();

    expect(queryMock).toHaveBeenCalledWith("integration_feedback:listPending", { limit: 25 });
    expect(mutationMock).toHaveBeenCalledWith("integration_feedback:processById", {
      id: "integration_feedback_events:1",
    });
  });

  it("posts github task feedback comments through capability provider", async () => {
    const mutationMock = vi.fn().mockResolvedValue({ status: "sent" });
    const { client, queryMock } = createMockClient(mutationMock);
    queryMock.mockImplementation(async (endpoint: string, args?: Record<string, unknown>) => {
      if (endpoint === "integration_feedback:listPending") {
        return [
          {
            _id: "integration_feedback_events:2",
            integrationId: "integrations:github",
            topic: "task",
            taskId: "tasks:1",
            eventType: "task_status_changed",
            payloadJson: JSON.stringify({
              fromStatus: "doing",
              status: "review",
              output: "Implemented the change",
            }),
          },
        ];
      }
      if (endpoint === "integrations:get") {
        return {
          _id: args?.id,
          type: "github",
          enabled: true,
          config: { owner: "openclaw", repo: "openclaw", token: "github-token" },
        };
      }
      if (endpoint === "tasks:get") {
        return {
          _id: args?.id,
          goal: "Implement feature",
          input: JSON.stringify({
            intake: {
              resourceId: "openclaw/openclaw#42",
            },
          }),
        };
      }
      if (endpoint === "tasks:getExecutionRepoContext") {
        return {
          repoPath: "/tmp/does-not-exist",
        };
      }
      return null;
    });

    const worker = createIntegrationFeedbackWorker(client, { pollEveryMs: 60_000, batchLimit: 10 });
    await worker.start(createContext());
    await worker.stop();

    expect(postIssueCommentMock).not.toHaveBeenCalled();
    expect(mutationMock).toHaveBeenCalledWith("integration_feedback:processById", {
      id: "integration_feedback_events:2",
    });
  });

  it("posts github task feedback comments only when repo opts in via .flux/golden-path.yaml", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "squads-feedback-optin-"));
    try {
      await mkdir(path.join(tmpRoot, ".flux"), { recursive: true });
      await writeFile(
        path.join(tmpRoot, ".flux", "golden-path.yaml"),
        [
          "contractVersion: 3",
          "resourceType: issue",
          "feedback:",
          "  github:",
          "    postTaskStatusComments: true",
          "globalContext:",
          "  files: []",
          "lifecycle: []",
          "",
        ].join("\n"),
      );

      const mutationMock = vi.fn().mockResolvedValue({ status: "sent" });
      const { client, queryMock } = createMockClient(mutationMock);
      queryMock.mockImplementation(async (endpoint: string, args?: Record<string, unknown>) => {
        if (endpoint === "integration_feedback:listPending") {
          return [
            {
              _id: "integration_feedback_events:3",
              integrationId: "integrations:github",
              topic: "task",
              taskId: "tasks:1",
              eventType: "task_status_changed",
              payloadJson: JSON.stringify({
                fromStatus: "doing",
                status: "review",
                output: "Implemented the change",
              }),
            },
          ];
        }
        if (endpoint === "integrations:get") {
          return {
            _id: args?.id,
            type: "github",
            enabled: true,
            config: { owner: "openclaw", repo: "openclaw", token: "github-token" },
          };
        }
        if (endpoint === "tasks:get") {
          return {
            _id: args?.id,
            goal: "Implement feature",
            input: JSON.stringify({
              intake: {
                resourceId: "openclaw/openclaw#42",
              },
            }),
          };
        }
        if (endpoint === "tasks:getExecutionRepoContext") {
          return {
            repoPath: tmpRoot,
          };
        }
        return null;
      });

      const worker = createIntegrationFeedbackWorker(client, {
        pollEveryMs: 60_000,
        batchLimit: 10,
      });
      await worker.start(createContext());
      await worker.stop();

      expect(postIssueCommentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "openclaw",
          repo: "openclaw",
          issueNumber: 42,
          auth: { kind: "token", token: "github-token" },
        }),
      );
      expect(mutationMock).toHaveBeenCalledWith("integration_feedback:processById", {
        id: "integration_feedback_events:3",
      });
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("backs off after repeated failures and retries later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-11T00:00:00.000Z"));
    const mutationMock = vi.fn().mockResolvedValue({ status: "sent" });
    const { client, queryMock } = createMockClient(mutationMock);
    queryMock
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockRejectedValueOnce(new Error("still down"))
      .mockResolvedValue([]);
    const worker = createIntegrationFeedbackWorker(client, { pollEveryMs: 1_000 });

    await worker.start(createContext());
    expect(queryMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(queryMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(queryMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(queryMock).toHaveBeenCalledTimes(3);

    await worker.stop();
  });
});
