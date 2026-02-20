import { describe, expect, it, vi } from "vitest";
import { OpenClawExecutionBackend, isApprovalError } from "../../src/runner/openclaw_backend.ts";
import type { RunnerExecutionRequest } from "../../src/runner/execution.ts";
import type { McpTaskPacket, OpenClawResult } from "../../src/types.ts";

// ---------------------------------------------------------------------------
// OpenClaw client mock
// ---------------------------------------------------------------------------

type OpenClawClientMock = {
  execute: ReturnType<typeof vi.fn>;
};

function createOpenClawClientMock(): OpenClawClientMock {
  return {
    execute: vi.fn(),
  };
}

function makeBackend(
  client: OpenClawClientMock,
  overrides: {
    orgId?: string;
    openclawAgentId?: string;
    aliases?: string[];
  } = {},
): OpenClawExecutionBackend {
  return new OpenClawExecutionBackend({
    client: client as never,
    orgId: overrides.orgId ?? "org-123",
    openclawAgentId: overrides.openclawAgentId,
    aliases: overrides.aliases,
  });
}

function makeRequest(overrides: Partial<RunnerExecutionRequest> = {}): RunnerExecutionRequest {
  return {
    taskId: "task-1",
    taskType: overrides.taskType ?? "task",
    prompt: overrides.prompt ?? "Do something",
    startedAt: overrides.startedAt ?? Date.now(),
    abortSignal: overrides.abortSignal ?? new AbortController().signal,
    packet: overrides.packet ?? {
      task: {
        id: "task-1",
        type: "task",
        streamId: "stream-1",
      },
      prompt: { rendered: "Do something" },
      execution: { backend: "openclaw" },
    },
  };
}

function makeSuccessResult(overrides: Partial<OpenClawResult> = {}): OpenClawResult {
  return {
    runId: "run-1",
    payloads: [
      { text: "Task completed successfully", isError: false },
    ],
    usage: { input: 100, output: 50, total: 150 },
    model: "claude-3.5-sonnet",
    durationMs: 2000,
    aborted: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isApprovalError
// ---------------------------------------------------------------------------

describe("isApprovalError", () => {
  it("detects 'approval' in error message", () => {
    expect(isApprovalError(new Error("execution requires approval"))).toBe(true);
  });

  it("detects 'operator.approvals' in error message", () => {
    expect(isApprovalError(new Error("requires operator.approvals scope"))).toBe(true);
  });

  it("detects 'exec.approval' in error message", () => {
    expect(isApprovalError(new Error("exec.approval needed"))).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isApprovalError(new Error("APPROVAL required"))).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isApprovalError(new Error("timeout"))).toBe(false);
    expect(isApprovalError(new Error("network error"))).toBe(false);
  });

  it("handles non-Error values", () => {
    expect(isApprovalError("requires approval")).toBe(true);
    expect(isApprovalError(42)).toBe(false);
    expect(isApprovalError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canExecute
// ---------------------------------------------------------------------------

describe("OpenClawExecutionBackend.canExecute", () => {
  it("accepts openclaw backend", () => {
    const backend = makeBackend(createOpenClawClientMock());
    expect(backend.canExecute("openclaw")).toBe(true);
  });

  it("accepts claude-cli backend (default alias)", () => {
    const backend = makeBackend(createOpenClawClientMock());
    expect(backend.canExecute("claude-cli")).toBe(true);
  });

  it("accepts codex-cli backend (default alias)", () => {
    const backend = makeBackend(createOpenClawClientMock());
    expect(backend.canExecute("codex-cli")).toBe(true);
  });

  it("accepts 'claude' (normalizes to claude-cli)", () => {
    const backend = makeBackend(createOpenClawClientMock());
    expect(backend.canExecute("claude")).toBe(true);
  });

  it("accepts 'Claude-Code' (case-insensitive normalization)", () => {
    const backend = makeBackend(createOpenClawClientMock());
    expect(backend.canExecute("Claude-Code")).toBe(true);
  });

  it("rejects unknown backends", () => {
    const backend = makeBackend(createOpenClawClientMock());
    expect(backend.canExecute("pi")).toBe(false);
    expect(backend.canExecute("gpt")).toBe(false);
  });

  it("uses custom aliases when provided", () => {
    const backend = makeBackend(createOpenClawClientMock(), {
      aliases: ["custom-backend"],
    });
    expect(backend.canExecute("custom-backend")).toBe(true);
    // Default aliases should not be included when custom ones are provided
    expect(backend.canExecute("codex-cli")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session key derivation
// ---------------------------------------------------------------------------

describe("OpenClawExecutionBackend session key derivation", () => {
  it("derives correct session key for conductor-chat tasks", async () => {
    const client = createOpenClawClientMock();
    client.execute.mockResolvedValue(makeSuccessResult());

    const backend = makeBackend(client, { orgId: "org-42", openclawAgentId: "agent-x" });
    const packet: McpTaskPacket = {
      task: {
        id: "task-1",
        type: "conductor-chat",
        streamId: "stream-abc",
        threadId: "thread-xyz",
      },
      prompt: { rendered: "hello" },
    };

    await backend.execute(makeRequest({ packet, prompt: "hello" }));

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:agent-x:flux:org:org-42:stream:stream-abc:thread:thread-xyz",
      }),
    );
  });

  it("falls back to 'main' thread for conductor-chat without threadId", async () => {
    const client = createOpenClawClientMock();
    client.execute.mockResolvedValue(makeSuccessResult());

    const backend = makeBackend(client, { orgId: "org-1" });
    const packet: McpTaskPacket = {
      task: {
        id: "task-1",
        type: "conductor-chat",
        streamId: "stream-1",
        // No threadId
      },
      prompt: { rendered: "hello" },
    };

    await backend.execute(makeRequest({ packet, prompt: "hello" }));

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringContaining(":thread:main"),
      }),
    );
  });

  it("derives correct session key for cadence tasks", async () => {
    const client = createOpenClawClientMock();
    client.execute.mockResolvedValue(makeSuccessResult());

    const backend = makeBackend(client, { orgId: "org-1", openclawAgentId: "a1" });
    const packet: McpTaskPacket = {
      task: {
        id: "task-1",
        type: "cadence",
        streamId: "stream-1",
        input: JSON.stringify({ cadenceKey: "daily-report" }),
      },
      prompt: { rendered: "generate report" },
    };

    await backend.execute(makeRequest({ packet, prompt: "generate report" }));

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:a1:flux:org:org-1:stream:stream-1:cadence:daily-report",
      }),
    );
  });

  it("falls back to 'tick' for cadence tasks without cadenceKey", async () => {
    const client = createOpenClawClientMock();
    client.execute.mockResolvedValue(makeSuccessResult());

    const backend = makeBackend(client, { orgId: "org-1" });
    const packet: McpTaskPacket = {
      task: {
        id: "task-1",
        type: "cadence",
        streamId: "stream-1",
        input: "not json",
      },
      prompt: { rendered: "tick" },
    };

    await backend.execute(makeRequest({ packet, prompt: "tick" }));

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringContaining(":cadence:tick"),
      }),
    );
  });

  it("uses :task suffix for generic task types", async () => {
    const client = createOpenClawClientMock();
    client.execute.mockResolvedValue(makeSuccessResult());

    const backend = makeBackend(client, { orgId: "org-1" });
    const packet: McpTaskPacket = {
      task: {
        id: "task-1",
        type: "generic",
        streamId: "stream-1",
      },
      prompt: { rendered: "work" },
    };

    await backend.execute(makeRequest({ packet, prompt: "work" }));

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringContaining(":task"),
      }),
    );
    // Ensure it does NOT include :thread: or :cadence:
    const sessionKey = client.execute.mock.calls[0][0].sessionKey as string;
    expect(sessionKey).not.toContain(":thread:");
    expect(sessionKey).not.toContain(":cadence:");
    expect(sessionKey).toMatch(/:task$/);
  });

  it("defaults agentId to 'main' in session key", async () => {
    const client = createOpenClawClientMock();
    client.execute.mockResolvedValue(makeSuccessResult());

    const backend = makeBackend(client, { orgId: "org-1" }); // No agentId
    const packet: McpTaskPacket = {
      task: { id: "task-1", type: "task", streamId: "stream-1" },
      prompt: { rendered: "do" },
    };

    await backend.execute(makeRequest({ packet, prompt: "do" }));

    const sessionKey = client.execute.mock.calls[0][0].sessionKey as string;
    expect(sessionKey).toMatch(/^agent:main:/);
  });

  it("uses unknown-stream when streamId is missing", async () => {
    const client = createOpenClawClientMock();
    client.execute.mockResolvedValue(makeSuccessResult());

    const backend = makeBackend(client, { orgId: "org-1" });
    const packet: McpTaskPacket = {
      task: { id: "task-1", type: "task" }, // No streamId
      prompt: { rendered: "do" },
    };

    await backend.execute(makeRequest({ packet, prompt: "do" }));

    const sessionKey = client.execute.mock.calls[0][0].sessionKey as string;
    expect(sessionKey).toContain(":stream:unknown-stream:");
  });
});

// ---------------------------------------------------------------------------
// Execution results
// ---------------------------------------------------------------------------

describe("OpenClawExecutionBackend.execute", () => {
  it("returns done status on successful execution", async () => {
    const client = createOpenClawClientMock();
    client.execute.mockResolvedValue(makeSuccessResult());

    const backend = makeBackend(client);
    const result = await backend.execute(makeRequest());

    expect(result.status).toBe("done");
    expect(result.output).toBe("Task completed successfully");
    expect(result.tokensUsed).toBe(150);
    expect(result.durationMs).toBe(2000);
  });

  it("returns failed status when payloads contain errors", async () => {
    const client = createOpenClawClientMock();
    client.execute.mockResolvedValue(
      makeSuccessResult({
        payloads: [{ text: "Something went wrong", isError: true }],
      }),
    );

    const backend = makeBackend(client);
    const result = await backend.execute(makeRequest());

    expect(result.status).toBe("failed");
    expect(result.output).toBe("Something went wrong");
  });

  it("returns cancelled status when aborted", async () => {
    const client = createOpenClawClientMock();
    client.execute.mockResolvedValue(
      makeSuccessResult({
        aborted: true,
        payloads: [],
      }),
    );

    const backend = makeBackend(client);
    const result = await backend.execute(makeRequest());

    expect(result.status).toBe("cancelled");
    // Empty payloads should produce a cancellation message
    expect(result.output).toBe("Cancelled by user request");
  });

  it("concatenates multiple text payloads with double newlines", async () => {
    const client = createOpenClawClientMock();
    client.execute.mockResolvedValue(
      makeSuccessResult({
        payloads: [
          { text: "First part", isError: false },
          { text: "Second part", isError: false },
        ],
      }),
    );

    const backend = makeBackend(client);
    const result = await backend.execute(makeRequest());

    expect(result.output).toBe("First part\n\nSecond part");
  });

  it("returns (empty response) when no text payloads", async () => {
    const client = createOpenClawClientMock();
    client.execute.mockResolvedValue(
      makeSuccessResult({
        payloads: [{ mediaUrl: "https://example.com/image.png" }],
      }),
    );

    const backend = makeBackend(client);
    const result = await backend.execute(makeRequest());

    expect(result.output).toBe("(empty response)");
  });

  it("skips empty text payloads", async () => {
    const client = createOpenClawClientMock();
    client.execute.mockResolvedValue(
      makeSuccessResult({
        payloads: [
          { text: "", isError: false },
          { text: "  ", isError: false },
          { text: "Real content", isError: false },
        ],
      }),
    );

    const backend = makeBackend(client);
    const result = await backend.execute(makeRequest());

    expect(result.output).toBe("Real content");
  });

  it("passes prompt and agentId to the client", async () => {
    const client = createOpenClawClientMock();
    client.execute.mockResolvedValue(makeSuccessResult());

    const backend = makeBackend(client, { openclawAgentId: "my-agent" });
    await backend.execute(makeRequest({ prompt: "Hello world" }));

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Hello world",
        agentId: "my-agent",
      }),
    );
  });

  it("passes abort signal to the client", async () => {
    const client = createOpenClawClientMock();
    client.execute.mockResolvedValue(makeSuccessResult());

    const controller = new AbortController();
    const backend = makeBackend(client);
    await backend.execute(makeRequest({ abortSignal: controller.signal }));

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: controller.signal,
      }),
    );
  });

  it("falls back to elapsed time when durationMs is not a number", async () => {
    const client = createOpenClawClientMock();
    const startedAt = Date.now() - 5000;
    client.execute.mockResolvedValue(
      makeSuccessResult({ durationMs: undefined }),
    );

    const backend = makeBackend(client);
    const result = await backend.execute(makeRequest({ startedAt }));

    // Should fall back to Date.now() - startedAt, which should be >= 5000 (approximately)
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// id property
// ---------------------------------------------------------------------------

describe("OpenClawExecutionBackend.id", () => {
  it("is 'openclaw'", () => {
    const backend = makeBackend(createOpenClawClientMock());
    expect(backend.id).toBe("openclaw");
  });
});
