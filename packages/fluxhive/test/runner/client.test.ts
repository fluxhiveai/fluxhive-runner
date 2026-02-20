import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FluxMcpClient, McpHttpError, wsUrlToHttpOrigin } from "../../src/runner/client.ts";

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function mockFetchResponse(status: number, body: unknown, ok?: boolean) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  fetchMock.mockResolvedValueOnce({
    ok: ok ?? (status >= 200 && status < 300),
    status,
    text: async () => text,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("McpHttpError", () => {
  it("has status, code, and body properties", () => {
    const error = new McpHttpError("fail", { status: 422, code: "INVALID", body: { detail: "bad" } });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("McpHttpError");
    expect(error.message).toBe("fail");
    expect(error.status).toBe(422);
    expect(error.code).toBe("INVALID");
    expect(error.body).toEqual({ detail: "bad" });
  });

  it("defaults code to undefined when not provided", () => {
    const error = new McpHttpError("nope", { status: 500 });
    expect(error.code).toBeUndefined();
    expect(error.body).toBeUndefined();
  });
});

describe("wsUrlToHttpOrigin", () => {
  it("converts wss: to https:", () => {
    expect(wsUrlToHttpOrigin("wss://example.com/push")).toBe("https://example.com");
  });

  it("converts ws: to http:", () => {
    expect(wsUrlToHttpOrigin("ws://localhost:3000/push")).toBe("http://localhost:3000");
  });

  it("throws on unsupported protocol", () => {
    expect(() => wsUrlToHttpOrigin("http://example.com")).toThrow("Unsupported WS protocol");
  });
});

describe("FluxMcpClient", () => {
  let client: FluxMcpClient;

  beforeEach(() => {
    fetchMock.mockReset();
    client = new FluxMcpClient({
      baseUrl: "https://api.example.com/mcp/v1/",
      token: "test-token-abc",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Authorization header
  // ---------------------------------------------------------------------------

  it("includes Authorization: Bearer token in all requests", async () => {
    mockFetchResponse(200, { ok: true });

    await client.hello();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-token-abc");
  });

  it("strips trailing slashes from baseUrl", async () => {
    mockFetchResponse(200, { id: "user-1" });
    await client.whoami();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/api\.example\.com\/mcp\/v1\/whoami/);
    expect(url).not.toContain("v1//");
  });

  // ---------------------------------------------------------------------------
  // whoami
  // ---------------------------------------------------------------------------

  describe("whoami()", () => {
    it("returns parsed response on success", async () => {
      const body = {
        agent: { id: "a1", slug: "demo", name: "Demo" },
        server: { version: "1.0.0" },
      };
      mockFetchResponse(200, body);

      const result = await client.whoami();
      expect(result).toEqual(body);
    });

    it("throws McpHttpError on non-2xx", async () => {
      mockFetchResponse(401, { message: "Unauthorized" });

      await expect(client.whoami()).rejects.toThrow(McpHttpError);
      try {
        await client.whoami();
      } catch (err) {
        // Already rejected above — that is fine; we tested the assertion.
      }
    });

    it("includes error code from nested error object", async () => {
      mockFetchResponse(403, { error: { code: "TOKEN_EXPIRED", message: "Token expired" } });

      try {
        await client.whoami();
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(McpHttpError);
        const httpErr = err as McpHttpError;
        expect(httpErr.status).toBe(403);
        expect(httpErr.code).toBe("TOKEN_EXPIRED");
        expect(httpErr.message).toBe("Token expired");
      }
    });

    it("falls back to a generic message when response body is not JSON", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: async () => "Bad Gateway",
      });

      try {
        await client.whoami();
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(McpHttpError);
        const httpErr = err as McpHttpError;
        expect(httpErr.status).toBe(502);
        // body falls back to { raw: "Bad Gateway" }
        expect(httpErr.body).toEqual({ raw: "Bad Gateway" });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // handshake
  // ---------------------------------------------------------------------------

  describe("handshake()", () => {
    it("sends correct body and returns parsed response", async () => {
      const response = {
        agentId: "agent-1",
        agentName: "Test Agent",
        config: { push: { wsUrl: "wss://push.example.com", mode: "websocket" } },
      };
      mockFetchResponse(200, response);

      const result = await client.handshake({
        runnerType: "test-runner",
        runnerVersion: "0.1.0",
        machineId: "m1",
        runnerInstanceId: "r1",
        backend: "claude-cli",
      });

      expect(result).toEqual(response);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/handshake");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.runnerType).toBe("test-runner");
      expect(body.machineId).toBe("m1");
      expect(body.backend).toBe("claude-cli");
    });
  });

  // ---------------------------------------------------------------------------
  // hello
  // ---------------------------------------------------------------------------

  describe("hello()", () => {
    it("fires POST with empty body", async () => {
      mockFetchResponse(200, { ok: true });

      await client.hello();

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/hello");
      expect(init.method).toBe("POST");
    });
  });

  // ---------------------------------------------------------------------------
  // listTasks
  // ---------------------------------------------------------------------------

  describe("listTasks()", () => {
    it("constructs query params from all options", async () => {
      mockFetchResponse(200, { tasks: [] });

      await client.listTasks({
        status: "todo",
        limit: 5,
        mode: "compact",
        format: "packet",
        streamId: "stream-1",
        backend: "claude-cli",
        costClass: "standard",
      });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(url);
      expect(parsed.searchParams.get("status")).toBe("todo");
      expect(parsed.searchParams.get("limit")).toBe("5");
      expect(parsed.searchParams.get("mode")).toBe("compact");
      expect(parsed.searchParams.get("format")).toBe("packet");
      expect(parsed.searchParams.get("streamId")).toBe("stream-1");
      expect(parsed.searchParams.get("backend")).toBe("claude-cli");
      expect(parsed.searchParams.get("costClass")).toBe("standard");
    });

    it("omits undefined/missing options from query", async () => {
      mockFetchResponse(200, { tasks: [] });

      await client.listTasks({ status: "todo" });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(url);
      expect(parsed.searchParams.get("status")).toBe("todo");
      expect(parsed.searchParams.has("limit")).toBe(false);
      expect(parsed.searchParams.has("backend")).toBe(false);
    });

    it("returns empty list for no tasks", async () => {
      mockFetchResponse(200, { tasks: [] });
      const result = await client.listTasks();
      expect(result.tasks).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // claimTask
  // ---------------------------------------------------------------------------

  describe("claimTask()", () => {
    it("sends runner metadata in body", async () => {
      mockFetchResponse(200, { sessionId: "session-abc", packet: {} });

      await client.claimTask("task-42", {
        runnerType: "runner-a",
        runnerVersion: "2.0",
        machineId: "m-1",
        runnerInstanceId: "i-1",
        backend: "claude-cli",
        format: "packet",
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/tasks/task-42/claim");
      const body = JSON.parse(init.body as string);
      expect(body.runnerType).toBe("runner-a");
      expect(body.runnerVersion).toBe("2.0");
      expect(body.machineId).toBe("m-1");
      expect(body.runnerInstanceId).toBe("i-1");
      expect(body.backend).toBe("claude-cli");
      expect(body.format).toBe("packet");
    });

    it("defaults format to 'packet' when not provided", async () => {
      mockFetchResponse(200, { sessionId: "s-1" });

      await client.claimTask("task-1", {
        runnerType: "r",
        runnerVersion: "1",
        machineId: "m",
        runnerInstanceId: "i",
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.format).toBe("packet");
    });

    it("throws McpHttpError with status 409 on conflict", async () => {
      mockFetchResponse(409, { message: "Task already claimed", code: "CONFLICT" });

      try {
        await client.claimTask("task-1", {
          runnerType: "r",
          runnerVersion: "1",
          machineId: "m",
          runnerInstanceId: "i",
        });
        expect.unreachable("should throw");
      } catch (err) {
        expect(err).toBeInstanceOf(McpHttpError);
        const httpErr = err as McpHttpError;
        expect(httpErr.status).toBe(409);
        expect(httpErr.code).toBe("CONFLICT");
      }
    });

    it("encodes taskId in URL path", async () => {
      mockFetchResponse(200, { sessionId: "s-1" });

      await client.claimTask("task/with spaces", {
        runnerType: "r",
        runnerVersion: "1",
        machineId: "m",
        runnerInstanceId: "i",
      });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/tasks/task%2Fwith%20spaces/claim");
    });
  });

  // ---------------------------------------------------------------------------
  // heartbeat
  // ---------------------------------------------------------------------------

  describe("heartbeat()", () => {
    it("sends sessionId and phase, returns shouldAbort/cancelReason", async () => {
      mockFetchResponse(200, { shouldAbort: true, cancelReason: "user cancelled" });

      const result = await client.heartbeat("task-1", "session-1", { phase: "executing" });

      expect(result.shouldAbort).toBe(true);
      expect(result.cancelReason).toBe("user cancelled");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/tasks/task-1/heartbeat");
      const body = JSON.parse(init.body as string);
      expect(body.sessionId).toBe("session-1");
      expect(body.phase).toBe("executing");
    });

    it("omits phase/progress when not provided", async () => {
      mockFetchResponse(200, { shouldAbort: false });

      await client.heartbeat("task-1", "session-1");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.sessionId).toBe("session-1");
      expect(body).not.toHaveProperty("phase");
      expect(body).not.toHaveProperty("progress");
    });
  });

  // ---------------------------------------------------------------------------
  // completeTask
  // ---------------------------------------------------------------------------

  describe("completeTask()", () => {
    it("sends all result fields", async () => {
      mockFetchResponse(200, { ok: true });

      await client.completeTask("task-1", "session-1", {
        status: "done",
        output: "Task complete",
        tokensUsed: 150,
        costUsd: 0.003,
        durationMs: 5000,
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/tasks/task-1/complete");
      const body = JSON.parse(init.body as string);
      expect(body.sessionId).toBe("session-1");
      expect(body.status).toBe("done");
      expect(body.output).toBe("Task complete");
      expect(body.tokensUsed).toBe(150);
      expect(body.costUsd).toBe(0.003);
      expect(body.durationMs).toBe(5000);
    });

    it("handles failed status", async () => {
      mockFetchResponse(200, { ok: true });

      await client.completeTask("task-1", "session-1", {
        status: "failed",
        output: "Error occurred",
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.status).toBe("failed");
    });
  });

  // ---------------------------------------------------------------------------
  // escalateTask
  // ---------------------------------------------------------------------------

  describe("escalateTask()", () => {
    it("sends reason and suggestedAction", async () => {
      mockFetchResponse(200, { ok: true });

      await client.escalateTask("task-1", "session-1", "needs approval", "retry after approval");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/tasks/task-1/escalate");
      const body = JSON.parse(init.body as string);
      expect(body.sessionId).toBe("session-1");
      expect(body.reason).toBe("needs approval");
      expect(body.suggestedAction).toBe("retry after approval");
    });

    it("omits suggestedAction when not provided", async () => {
      mockFetchResponse(200, { ok: true });

      await client.escalateTask("task-1", "session-1", "unknown error");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body).not.toHaveProperty("suggestedAction");
    });
  });

  // ---------------------------------------------------------------------------
  // mintPushTicket
  // ---------------------------------------------------------------------------

  describe("mintPushTicket()", () => {
    it("converts wsUrl to HTTP origin and posts to /mcp/v1/push-ticket", async () => {
      mockFetchResponse(200, { ticket: "ticket-xyz" });

      const result = await client.mintPushTicket({
        wsUrl: "wss://push.example.com/ws",
        streamId: "stream-1",
        backend: "claude-cli",
        costClass: "standard",
        runnerType: "runner-a",
        runnerVersion: "1.0",
        runnerInstanceId: "r-1",
        machineId: "m-1",
      });

      expect(result.ticket).toBe("ticket-xyz");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://push.example.com/mcp/v1/push-ticket");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.filters.streamId).toBe("stream-1");
      expect(body.filters.backend).toBe("claude-cli");
      expect(body.filters.costClass).toBe("standard");
      expect(body.runnerType).toBe("runner-a");
      expect(body.machineId).toBe("m-1");
    });

    it("sends null filters when streamId/backend/costClass not provided", async () => {
      mockFetchResponse(200, { ticket: "ticket-abc" });

      await client.mintPushTicket({
        wsUrl: "wss://push.example.com/ws",
        runnerType: "r",
        runnerVersion: "1",
        runnerInstanceId: "i",
        machineId: "m",
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.filters.streamId).toBeNull();
      expect(body.filters.backend).toBeNull();
      expect(body.filters.costClass).toBeNull();
    });

    it("throws McpHttpError on failure response", async () => {
      mockFetchResponse(500, { error: "internal" });

      await expect(
        client.mintPushTicket({
          wsUrl: "wss://push.example.com/ws",
          runnerType: "r",
          runnerVersion: "1",
          runnerInstanceId: "i",
          machineId: "m",
        }),
      ).rejects.toThrow(McpHttpError);
    });

    it("throws when response does not include a ticket string", async () => {
      mockFetchResponse(200, { noTicket: true }, true);

      await expect(
        client.mintPushTicket({
          wsUrl: "wss://push.example.com/ws",
          runnerType: "r",
          runnerVersion: "1",
          runnerInstanceId: "i",
          machineId: "m",
        }),
      ).rejects.toThrow("Failed to mint push ticket");
    });

    it("includes authorization header", async () => {
      mockFetchResponse(200, { ticket: "t" });

      await client.mintPushTicket({
        wsUrl: "wss://push.example.com/ws",
        runnerType: "r",
        runnerVersion: "1",
        runnerInstanceId: "i",
        machineId: "m",
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-token-abc");
    });
  });
});
