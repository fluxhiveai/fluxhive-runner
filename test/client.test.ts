import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FluxApiClient, McpHttpError } from "../src/client.ts";

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

  it("defaults code and body to undefined when not provided", () => {
    const error = new McpHttpError("nope", { status: 500 });
    expect(error.code).toBeUndefined();
    expect(error.body).toBeUndefined();
  });
});

describe("FluxApiClient", () => {
  let client: FluxApiClient;

  beforeEach(() => {
    fetchMock.mockReset();
    client = new FluxApiClient({
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

  it("includes Authorization: Bearer token in authenticated requests", async () => {
    mockFetchResponse(200, { agent: { id: "a1", slug: "s", name: "n" }, server: { version: "1" } });

    await client.whoami();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-token-abc");
  });

  it("strips trailing slashes from baseUrl", async () => {
    mockFetchResponse(200, { agent: { id: "a1", slug: "s", name: "n" }, server: { version: "1" } });
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

    it("falls back to generic message when body is not JSON", async () => {
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
        expect(httpErr.body).toEqual({ raw: "Bad Gateway" });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // health
  // ---------------------------------------------------------------------------

  describe("health()", () => {
    it("does not send auth header", async () => {
      mockFetchResponse(200, { ok: true });

      await client.health();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    });

    it("returns health status", async () => {
      mockFetchResponse(200, { ok: true, version: "1.2.3" });

      const result = await client.health();
      expect(result.ok).toBe(true);
      expect(result.version).toBe("1.2.3");
    });
  });

  // ---------------------------------------------------------------------------
  // openapi
  // ---------------------------------------------------------------------------

  describe("openapi()", () => {
    it("returns parsed JSON spec", async () => {
      const spec = { openapi: "3.0.3", info: { title: "Flux MCP API" } };
      mockFetchResponse(200, spec);

      const result = await client.openapi();
      expect(result).toEqual(spec);
    });
  });

  // ---------------------------------------------------------------------------
  // accessRedeem
  // ---------------------------------------------------------------------------

  describe("accessRedeem()", () => {
    it("sends orgId and inviteCode without auth header", async () => {
      mockFetchResponse(200, {
        ok: true,
        credentials: {
          token: "new-token",
          tokenType: "bearer",
          orgId: "org-1",
          agentId: "agent-1",
          agentSlug: "demo-agent",
          agentName: "Demo Agent",
          issuedAt: 1234567890,
        },
      });

      const result = await client.accessRedeem({
        orgId: "org-1",
        inviteCode: "INVITE123",
        agentLabel: "test-label",
      });

      expect(result.credentials.token).toBe("new-token");
      expect(result.credentials.agentSlug).toBe("demo-agent");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/agent-access/redeem");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();

      const body = JSON.parse(init.body as string);
      expect(body.orgId).toBe("org-1");
      expect(body.inviteCode).toBe("INVITE123");
      expect(body.agentLabel).toBe("test-label");
    });
  });

  // ---------------------------------------------------------------------------
  // accessRequest
  // ---------------------------------------------------------------------------

  describe("accessRequest()", () => {
    it("sends request and returns requestId + pollSecret", async () => {
      mockFetchResponse(200, {
        ok: true,
        status: "pending",
        requestId: "req-1",
        pollSecret: "secret-abc",
      });

      const result = await client.accessRequest({
        orgId: "org-1",
        inviteCode: "INVITE123",
      });

      expect(result.requestId).toBe("req-1");
      expect(result.pollSecret).toBe("secret-abc");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/agent-access/request");
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // accessPoll
  // ---------------------------------------------------------------------------

  describe("accessPoll()", () => {
    it("passes requestId in path and pollSecret as query param", async () => {
      mockFetchResponse(200, { ok: true, status: "approved" });

      const result = await client.accessPoll("req-123", "secret-xyz");

      expect(result.status).toBe("approved");

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/agent-access/requests/req-123");
      const parsed = new URL(url);
      expect(parsed.searchParams.get("pollSecret")).toBe("secret-xyz");
    });

    it("encodes special characters in requestId", async () => {
      mockFetchResponse(200, { ok: true, status: "pending" });

      await client.accessPoll("req/with spaces", "s");

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/agent-access/requests/req%2Fwith%20spaces");
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

    it("omits undefined options from query", async () => {
      mockFetchResponse(200, { tasks: [] });

      await client.listTasks({ status: "todo" });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(url);
      expect(parsed.searchParams.get("status")).toBe("todo");
      expect(parsed.searchParams.has("limit")).toBe(false);
      expect(parsed.searchParams.has("backend")).toBe(false);
    });

    it("returns tasks array", async () => {
      const tasks = [
        { _id: "t1", status: "todo", goal: "Fix bug" },
        { _id: "t2", status: "doing", goal: "Add feature" },
      ];
      mockFetchResponse(200, { tasks });

      const result = await client.listTasks();
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0]._id).toBe("t1");
    });

    it("returns empty list for no tasks", async () => {
      mockFetchResponse(200, { tasks: [] });
      const result = await client.listTasks();
      expect(result.tasks).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // createTask
  // ---------------------------------------------------------------------------

  describe("createTask()", () => {
    it("sends required fields and returns taskId", async () => {
      mockFetchResponse(200, { ok: true, taskId: "task-new-1" });

      const result = await client.createTask({
        type: "general",
        goal: "Deploy new version",
        input: "Run the deploy script",
      });

      expect(result.taskId).toBe("task-new-1");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/tasks");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.type).toBe("general");
      expect(body.goal).toBe("Deploy new version");
      expect(body.input).toBe("Run the deploy script");
    });

    it("sends optional fields when provided", async () => {
      mockFetchResponse(200, { ok: true, taskId: "task-new-2" });

      await client.createTask({
        type: "code-review",
        goal: "Review PR #42",
        input: "Check for security issues",
        streamId: "stream-1",
        skillId: "skill-1",
        priority: 1,
        executionBackend: "claude-cli",
        executionModel: "opus",
        dependencies: ["task-1"],
        contextFrom: ["task-0"],
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.streamId).toBe("stream-1");
      expect(body.skillId).toBe("skill-1");
      expect(body.priority).toBe(1);
      expect(body.executionBackend).toBe("claude-cli");
      expect(body.executionModel).toBe("opus");
      expect(body.dependencies).toEqual(["task-1"]);
      expect(body.contextFrom).toEqual(["task-0"]);
    });
  });

  // ---------------------------------------------------------------------------
  // listStreams
  // ---------------------------------------------------------------------------

  describe("listStreams()", () => {
    it("sends status query param", async () => {
      mockFetchResponse(200, { streams: [] });

      await client.listStreams({ status: "active" });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(url);
      expect(parsed.searchParams.get("status")).toBe("active");
    });

    it("omits status when not provided", async () => {
      mockFetchResponse(200, { streams: [] });

      await client.listStreams();

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(url);
      expect(parsed.searchParams.has("status")).toBe(false);
    });

    it("returns streams array", async () => {
      const streams = [
        { _id: "s1", title: "Main", slug: "main", status: "active" },
      ];
      mockFetchResponse(200, { streams });

      const result = await client.listStreams();
      expect(result.streams).toHaveLength(1);
      expect(result.streams[0].title).toBe("Main");
    });
  });
});
