import type { ConvexClient } from "convex/browser";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../core/types.js";

const listProjectIssuesByStatusMock = vi.fn();

vi.mock("../capabilities/github/provider-openclaw.js", () => ({
  createOpenClawGitHubCapabilityProvider: vi.fn(() => ({
    providerName: "openclaw",
    listProjectIssuesByStatus: vi.fn(async (args: { statuses?: string[] }) => {
      const statuses = Array.isArray(args.statuses) ? args.statuses : [];
      const issues = await listProjectIssuesByStatusMock(statuses);
      return { issues };
    }),
  })),
}));

vi.mock("../core/convex-client.js", () => ({
  api: {
    integrations: {
      list: "integrations:list",
      update: "integrations:update",
    },
    intake_events: {
      ingest: "intake_events:ingest",
      routeAgentic: "intake_events:routeAgentic",
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

function createContext(): RuntimeContext {
  return { convexUrl: "https://test.convex.cloud" };
}

type MockClient = {
  client: ConvexClient;
  queryMock: ReturnType<typeof vi.fn>;
  mutationMock: ReturnType<typeof vi.fn>;
  actionMock: ReturnType<typeof vi.fn>;
};

function createMockClient(overrides: {
  queryImpl?: (endpoint: string, args?: Record<string, unknown>) => Promise<unknown>;
} = {}): MockClient {
  const queryMock = vi.fn(async (endpoint: string, args?: Record<string, unknown>) => {
    if (overrides.queryImpl) {
      return overrides.queryImpl(endpoint, args);
    }
    if (endpoint === "integrations:list") {
      return [
        {
          _id: "integrations:1",
          streamId: "streams:1",
          type: "github",
          name: "GitHub",
          enabled: true,
          config: {
            owner: "openclaw",
            repo: "openclaw",
            projectNumber: 7,
            token: "test-github-token",
          },
          intakeConfig: { stages: { Todo: { agent: "triage" } } },
        },
      ];
    }
    return null;
  });

  const mutationMock = vi.fn(async (endpoint: string, args?: Record<string, unknown>) => {
    if (endpoint === "intake_events:ingest") {
      return { eventId: "intake_events:1", args };
    }
    return undefined;
  });

  const actionMock = vi.fn(async (endpoint: string) => {
    if (endpoint === "intake_events:routeAgentic") {
      return { status: "routed", runId: "runs:1" };
    }
    return undefined;
  });

  return {
    client: {
      query: queryMock,
      mutation: mutationMock,
      action: actionMock,
    } as unknown as ConvexClient,
    queryMock,
    mutationMock,
    actionMock,
  };
}

describe("createIntegrationIntakeWorker", () => {
  let createIntegrationIntakeWorker: typeof import("./integration-intake-worker.js").createIntegrationIntakeWorker;
  let createGitHubIntakeAdapter: typeof import("./github-intake-adapter.js").createGitHubIntakeAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    listProjectIssuesByStatusMock.mockResolvedValue([]);
    vi.resetModules();
    const [workerMod, adapterMod] = await Promise.all([
      import("./integration-intake-worker.js"),
      import("./github-intake-adapter.js"),
    ]);
    createIntegrationIntakeWorker = workerMod.createIntegrationIntakeWorker;
    createGitHubIntakeAdapter = adapterMod.createGitHubIntakeAdapter;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls github integrations and ingests one issue", async () => {
    listProjectIssuesByStatusMock.mockResolvedValueOnce([
      {
        number: 42,
        title: "Customer issue",
        projectStatus: "Todo",
        updatedAt: "2026-02-11T20:30:00.000Z",
      },
    ]);

    const { client, mutationMock, actionMock } = createMockClient();
    const worker = createIntegrationIntakeWorker(client, {
      pollEveryMs: 60_000,
      adapters: [createGitHubIntakeAdapter()],
    });

    await worker.start(createContext());
    await worker.stop();

    expect(mutationMock).toHaveBeenCalledWith(
      "intake_events:ingest",
      expect.objectContaining({
        integrationId: "integrations:1",
        streamId: "streams:1",
        resourceType: "issue",
        resourceId: "openclaw/openclaw#42",
        autoRoute: false,
      }),
    );
    expect(actionMock).toHaveBeenCalledWith("intake_events:routeAgentic", {
      intakeEventId: "intake_events:1",
    });
    expect(mutationMock).toHaveBeenCalledWith(
      "integrations:update",
      expect.objectContaining({
        id: "integrations:1",
        intakeCursor: expect.any(String),
      }),
    );
  });

  it("derives poll statuses from .flux/golden-path.yaml when repoPath is configured", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "flux-golden-path-"));
    try {
      await mkdir(path.join(tmpRoot, ".flux"), { recursive: true });
      await writeFile(
        path.join(tmpRoot, ".flux", "golden-path.yaml"),
        [
          "contractVersion: 3",
          "resourceType: issue",
          "lifecycle:",
          "  - key: groom",
          "    statuses:",
          "      - name: Groom",
          '        id: "status-groom"',
          "      - name: Discovery",
          '        id: "status-discovery"',
          "    skill: .flux/skills/00-groom.md",
          "",
        ].join("\n"),
      );

      const { client } = createMockClient({
        queryImpl: async (endpoint: string) => {
          if (endpoint === "integrations:list") {
            return [
              {
                _id: "integrations:1",
                streamId: "streams:1",
                type: "github",
                name: "GitHub",
                enabled: true,
                config: {
                  owner: "openclaw",
                  repo: "openclaw",
                  projectNumber: 7,
                  repoPath: tmpRoot,
                  token: "test-github-token",
                },
                intakeConfig: {},
              },
            ];
          }
          return null;
        },
      });

      const worker = createIntegrationIntakeWorker(client, {
        pollEveryMs: 60_000,
        adapters: [createGitHubIntakeAdapter()],
      });

      await worker.start(createContext());
      await worker.stop();

      expect(listProjectIssuesByStatusMock).toHaveBeenCalledWith(["Groom", "Discovery"]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("records integration errors and backs off on adapter failures", async () => {
    const { client, mutationMock } = createMockClient({
      queryImpl: async (endpoint: string) => {
        if (endpoint === "integrations:list") {
          return [
            {
              _id: "integrations:custom",
              type: "custom-ticketing",
              name: "Custom",
              enabled: true,
            },
          ];
        }
        return null;
      },
    });

    const worker = createIntegrationIntakeWorker(client, {
      pollEveryMs: 60_000,
      adapters: [
        {
          type: "custom-ticketing",
          pollIntegration: vi.fn(async () => {
            throw new Error("rate limited");
          }),
        },
      ],
    });

    await worker.start(createContext());
    await worker.stop();

    expect(mutationMock).toHaveBeenCalledWith(
      "integrations:update",
      expect.objectContaining({
        id: "integrations:custom",
        lastError: "rate limited",
      }),
    );
  });

  it("polls integrations concurrently when pollConcurrency > 1", async () => {
    const { client } = createMockClient({
      queryImpl: async (endpoint: string) => {
        if (endpoint === "integrations:list") {
          return [
            {
              _id: "integrations:a",
              type: "custom-a",
              name: "Custom A",
              enabled: true,
            },
            {
              _id: "integrations:b",
              type: "custom-b",
              name: "Custom B",
              enabled: true,
            },
          ];
        }
        return null;
      },
    });

    let resolveA: (() => void) | undefined;
    const startedA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const pollA = vi.fn(async () => {
      await startedA;
    });
    const pollB = vi.fn().mockResolvedValue(undefined);

    const worker = createIntegrationIntakeWorker(client, {
      pollEveryMs: 60_000,
      pollConcurrency: 2,
      adapters: [
        { type: "custom-a", pollIntegration: pollA },
        { type: "custom-b", pollIntegration: pollB },
      ],
    });

    const startPromise = worker.start(createContext());
    await vi.waitFor(() => {
      expect(pollB).toHaveBeenCalledTimes(1);
    });

    resolveA?.();
    await startPromise;
    await worker.stop();
  });

  it("marks integration failure when adapter poll times out", async () => {
    const { client, mutationMock } = createMockClient({
      queryImpl: async (endpoint: string) => {
        if (endpoint === "integrations:list") {
          return [
            {
              _id: "integrations:slow",
              type: "custom-slow",
              name: "Custom Slow",
              enabled: true,
            },
          ];
        }
        return null;
      },
    });

    const never = new Promise<void>(() => {});
    const worker = createIntegrationIntakeWorker(client, {
      pollEveryMs: 60_000,
      pollTimeoutMs: 10,
      adapters: [
        {
          type: "custom-slow",
          pollIntegration: vi.fn(async () => {
            await never;
          }),
        },
      ],
    });

    await worker.start(createContext());
    await worker.stop();

    expect(mutationMock).toHaveBeenCalledWith(
      "integrations:update",
      expect.objectContaining({
        id: "integrations:slow",
        lastError: expect.stringContaining("timed out"),
      }),
    );
  });
});
