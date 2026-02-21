import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { parseClaudeCliOutput } from "../../src/runner/claude_cli_backend.js";

// ---------------------------------------------------------------------------
// parseClaudeCliOutput (pure function tests)
// ---------------------------------------------------------------------------

describe("parseClaudeCliOutput", () => {
  it("returns raw JSON if not nested", () => {
    const raw = JSON.stringify({ ok: true, result: { a: 1 } });
    expect(parseClaudeCliOutput(raw)).toBe(raw);
  });

  it("unwraps nested result string when it is JSON", () => {
    const inner = JSON.stringify({ message: "pong" });
    const raw = JSON.stringify({ result: inner });
    expect(parseClaudeCliOutput(raw)).toBe(inner);
  });

  it("returns trimmed raw when not JSON", () => {
    expect(parseClaudeCliOutput("  hello  ")).toBe("hello");
  });

  it("returns full JSON when result is a plain text string", () => {
    const raw = JSON.stringify({ result: "plain text, not json" });
    expect(parseClaudeCliOutput(raw)).toBe(raw);
  });

  it("unwraps response field too", () => {
    const inner = JSON.stringify({ data: 42 });
    const raw = JSON.stringify({ response: inner });
    expect(parseClaudeCliOutput(raw)).toBe(inner);
  });

  it("extracts embedded JSON object from non-JSON text", () => {
    const obj = JSON.stringify({ key: "value" });
    const text = `Some preamble text ${obj} some trailing text`;
    expect(parseClaudeCliOutput(text)).toBe(obj);
  });

  it("returns raw text when embedded braces are not valid JSON", () => {
    const text = "Some text { not: valid json } more text";
    expect(parseClaudeCliOutput(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// ClaudeCliExecutionBackend (with mocked child_process and fs)
// ---------------------------------------------------------------------------

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(signal?: string) {
    this.killed = true;
  }
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

const { spawn } = await import("node:child_process");
const { existsSync } = await import("node:fs");
const { ClaudeCliExecutionBackend } = await import("../../src/runner/claude_cli_backend.ts");

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-1",
    taskType: "demo",
    prompt: "Do something",
    startedAt: Date.now(),
    abortSignal: new AbortController().signal,
    packet: {
      execution: { backend: "claude-cli" },
      prompt: { rendered: "Do something" },
    },
    ...overrides,
  };
}

describe("ClaudeCliExecutionBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it("canExecute returns true for claude-cli", () => {
    const backend = new ClaudeCliExecutionBackend();
    expect(backend.canExecute("claude-cli")).toBe(true);
    expect(backend.canExecute("claude")).toBe(true);
    expect(backend.canExecute("pi")).toBe(false);
  });

  it("execute returns done on success", async () => {
    const child = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const backend = new ClaudeCliExecutionBackend();
    const p = backend.execute(makeRequest() as never);

    // Simulate stdout
    child.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok" })));
    child.emit("close", 0);

    const result = await p;
    expect(result.status).toBe("done");
    expect(result.output).toContain("ok");
  });

  it("execute returns failed on non-zero exit", async () => {
    const child = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const backend = new ClaudeCliExecutionBackend();
    const p = backend.execute(makeRequest() as never);

    child.stderr.emit("data", Buffer.from("error message"));
    child.emit("close", 1);

    const result = await p;
    expect(result.status).toBe("failed");
    expect(result.output).toContain("error message");
  });

  it("execute returns cancelled on abort", async () => {
    const child = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const ac = new AbortController();

    const backend = new ClaudeCliExecutionBackend();
    const p = backend.execute(makeRequest({ abortSignal: ac.signal }) as never);

    ac.abort();
    child.emit("close", null);

    const result = await p;
    expect(result.status).toBe("cancelled");
  });

  it("execute returns (empty response) when stdout is empty", async () => {
    const child = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const backend = new ClaudeCliExecutionBackend();
    const p = backend.execute(makeRequest() as never);

    child.emit("close", 0);

    const result = await p;
    expect(result.status).toBe("done");
    expect(result.output).toBe("(empty response)");
  });

  it("handles spawn error event", async () => {
    const child = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const backend = new ClaudeCliExecutionBackend();
    const p = backend.execute(makeRequest() as never);

    child.emit("error", new Error("ENOENT"));

    const result = await p;
    expect(result.status).toBe("failed");
  });

  it("passes model and allowedTools through args", async () => {
    const child = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const backend = new ClaudeCliExecutionBackend();
    const p = backend.execute(makeRequest({
      packet: {
        execution: { backend: "claude-cli", model: "sonnet", allowedTools: ["Read", "Write"] },
        prompt: { rendered: "Hello" },
      },
    }) as never);

    child.emit("close", 0);
    await p;

    expect(spawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--model", "sonnet", "--allowedTools", "Read,Write"]),
      expect.anything(),
    );
  });

  it("spawn env does NOT contain FLUX_TOKEN or OPENCLAW_* secrets", async () => {
    // Set secrets in process.env to verify they're excluded
    const origToken = process.env.FLUX_TOKEN;
    const origOcUrl = process.env.OPENCLAW_GATEWAY_URL;
    const origOcToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    const origOcPw = process.env.OPENCLAW_GATEWAY_PASSWORD;
    const origOcAgent = process.env.OPENCLAW_AGENT_ID;
    process.env.FLUX_TOKEN = "secret-tok";
    process.env.OPENCLAW_GATEWAY_URL = "ws://secret";
    process.env.OPENCLAW_GATEWAY_TOKEN = "secret-gw-tok";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "secret-pw";
    process.env.OPENCLAW_AGENT_ID = "secret-agent";

    const child = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const backend = new ClaudeCliExecutionBackend();
    const p = backend.execute(makeRequest() as never);
    child.emit("close", 0);
    await p;

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const spawnEnv = spawnCall[2]?.env as Record<string, string> | undefined;
    expect(spawnEnv).toBeDefined();
    expect(spawnEnv).not.toHaveProperty("FLUX_TOKEN");
    expect(spawnEnv).not.toHaveProperty("OPENCLAW_GATEWAY_URL");
    expect(spawnEnv).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
    expect(spawnEnv).not.toHaveProperty("OPENCLAW_GATEWAY_PASSWORD");
    expect(spawnEnv).not.toHaveProperty("OPENCLAW_AGENT_ID");

    // Restore
    if (origToken === undefined) delete process.env.FLUX_TOKEN; else process.env.FLUX_TOKEN = origToken;
    if (origOcUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL; else process.env.OPENCLAW_GATEWAY_URL = origOcUrl;
    if (origOcToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN; else process.env.OPENCLAW_GATEWAY_TOKEN = origOcToken;
    if (origOcPw === undefined) delete process.env.OPENCLAW_GATEWAY_PASSWORD; else process.env.OPENCLAW_GATEWAY_PASSWORD = origOcPw;
    if (origOcAgent === undefined) delete process.env.OPENCLAW_AGENT_ID; else process.env.OPENCLAW_AGENT_ID = origOcAgent;
  });

  it("uses CLAUDE_BIN env var when set and exists", async () => {
    const origEnv = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = "/custom/claude";
    vi.mocked(existsSync).mockImplementation((p) => p === "/custom/claude");

    const child = new MockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const backend = new ClaudeCliExecutionBackend();
    const p = backend.execute(makeRequest() as never);
    child.emit("close", 0);
    await p;

    expect(spawn).toHaveBeenCalledWith(
      "/custom/claude",
      expect.any(Array),
      expect.anything(),
    );

    if (origEnv === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = origEnv;
  });
});
