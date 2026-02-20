import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock pi-coding-agent before importing PiExecutionBackend
// ---------------------------------------------------------------------------

const mockPrompt = vi.fn();
const mockAbort = vi.fn();
const mockDispose = vi.fn();
const mockSubscribe = vi.fn().mockReturnValue(vi.fn());
const mockGetApiKey = vi.fn();
const mockFind = vi.fn();

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: vi.fn(),
  ModelRegistry: vi.fn().mockImplementation(() => ({
    find: mockFind,
    getApiKey: mockGetApiKey,
  })),
  createAgentSession: vi.fn().mockImplementation(() => ({
    session: {
      prompt: mockPrompt,
      abort: mockAbort,
      dispose: mockDispose,
      subscribe: mockSubscribe,
      state: { messages: [] },
    },
  })),
}));

const { PiExecutionBackend } = await import("../../src/runner/pi_backend.ts");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PiExecutionBackend", () => {
  beforeEach(() => vi.clearAllMocks());

  it("only handles pi backend", () => {
    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    expect(backend.canExecute("pi")).toBe(true);
    expect(backend.canExecute("PI")).toBe(true);
    expect(backend.canExecute("claude-cli")).toBe(false);
  });

  it("fails preflight when models.json is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fluxhive-runner-pi-"));
    const backend = new PiExecutionBackend({ agentDir: dir });
    const result = await backend.preflight();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("models.json");
  });

  it("passes preflight when models.json exists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fluxhive-runner-pi-"));
    await writeFile(path.join(dir, "models.json"), "{}", "utf8");
    const backend = new PiExecutionBackend({ agentDir: dir });
    expect(await backend.preflight()).toEqual({ ok: true });
  });

  it("fails execute when prompt.rendered is missing", async () => {
    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: { execution: { backend: "pi", model: "a/b" } },
    } as never);
    expect(result.status).toBe("failed");
    expect(result.output).toContain("prompt.rendered");
  });

  it("fails execute when execution.model is missing", async () => {
    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: { prompt: { rendered: "hello" }, execution: { backend: "pi" } },
    } as never);
    expect(result.status).toBe("failed");
    expect(result.output).toContain("execution.model");
  });

  it("fails execute when model format is invalid", async () => {
    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: { prompt: { rendered: "hello" }, execution: { backend: "pi", model: "no-slash" } },
    } as never);
    expect(result.status).toBe("failed");
    expect(result.output).toContain("Invalid execution.model");
  });

  it("fails when model not found in registry", async () => {
    mockFind.mockReturnValue(null);
    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: { prompt: { rendered: "hello" }, execution: { backend: "pi", model: "prov/mod" } },
    } as never);
    expect(result.status).toBe("failed");
    expect(result.output).toContain("PI model not found");
  });

  it("fails when no API key for non-bedrock non-local model", async () => {
    mockFind.mockReturnValue({ api: "openai", baseUrl: "https://api.openai.com" });
    mockGetApiKey.mockResolvedValue(null);
    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: { prompt: { rendered: "hello" }, execution: { backend: "pi", model: "prov/mod" } },
    } as never);
    expect(result.status).toBe("failed");
    expect(result.output).toContain("No PI auth resolved");
  });

  it("skips API key check for bedrock models", async () => {
    mockFind.mockReturnValue({ api: "bedrock-converse-stream", baseUrl: "https://aws.test" });
    mockGetApiKey.mockResolvedValue(null);
    mockPrompt.mockResolvedValue(undefined);

    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: { prompt: { rendered: "hello" }, execution: { backend: "pi", model: "aws/claude" } },
    } as never);
    expect(result.status).toBe("done");
    expect(mockDispose).toHaveBeenCalled();
  });

  it("skips API key check for local base URL", async () => {
    mockFind.mockReturnValue({ api: "openai", baseUrl: "http://localhost:8080" });
    mockGetApiKey.mockResolvedValue(null);
    mockPrompt.mockResolvedValue(undefined);

    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: { prompt: { rendered: "hello" }, execution: { backend: "pi", model: "local/mod" } },
    } as never);
    expect(result.status).toBe("done");
  });

  it("returns done with streamed text on success", async () => {
    mockFind.mockReturnValue({ api: "openai", baseUrl: "https://api.test" });
    mockGetApiKey.mockResolvedValue("key-123");
    // Simulate streaming via subscribe callback
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      cb({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello " },
      });
      cb({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "world" },
      });
      return vi.fn();
    });
    mockPrompt.mockResolvedValue(undefined);

    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: { prompt: { rendered: "hello" }, execution: { backend: "pi", model: "prov/mod" } },
    } as never);
    expect(result.status).toBe("done");
    expect(result.output).toBe("Hello world");
  });

  it("falls back to session messages when no streamed text", async () => {
    mockFind.mockReturnValue({ api: "openai", baseUrl: "https://api.test" });
    mockGetApiKey.mockResolvedValue("key-123");
    mockSubscribe.mockReturnValue(vi.fn());
    mockPrompt.mockImplementation(async function (this: unknown) {
      // Simulate session.state.messages having an assistant message
      const { createAgentSession } = await import("@mariozechner/pi-coding-agent");
      const mock = vi.mocked(createAgentSession);
      const lastCall = mock.mock.results[mock.mock.results.length - 1];
      if (lastCall?.type === "return") {
        (lastCall.value as { session: { state: { messages: unknown[] } } }).session.state.messages = [
          {
            role: "assistant",
            content: [{ type: "text", text: "Fallback text" }],
            usage: { totalTokens: 100, cost: { total: 0.01 } },
          },
        ];
      }
    });

    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: { prompt: { rendered: "hello" }, execution: { backend: "pi", model: "prov/mod" } },
    } as never);
    expect(result.status).toBe("done");
    expect(result.output).toBe("Fallback text");
    expect(result.tokensUsed).toBe(100);
    expect(result.costUsd).toBe(0.01);
  });

  it("returns cancelled when abort signal fires during prompt", async () => {
    mockFind.mockReturnValue({ api: "openai", baseUrl: "https://api.test" });
    mockGetApiKey.mockResolvedValue("key-123");
    mockSubscribe.mockReturnValue(vi.fn());
    const ac = new AbortController();
    mockPrompt.mockImplementation(async () => {
      ac.abort();
      throw new Error("aborted");
    });

    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: ac.signal,
      packet: { prompt: { rendered: "hello" }, execution: { backend: "pi", model: "prov/mod" } },
    } as never);
    expect(result.status).toBe("cancelled");
  });

  it("returns failed on prompt error (non-abort)", async () => {
    mockFind.mockReturnValue({ api: "openai", baseUrl: "https://api.test" });
    mockGetApiKey.mockResolvedValue("key-123");
    mockSubscribe.mockReturnValue(vi.fn());
    mockPrompt.mockRejectedValue(new Error("model error"));

    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: { prompt: { rendered: "hello" }, execution: { backend: "pi", model: "prov/mod" } },
    } as never);
    expect(result.status).toBe("failed");
    expect(result.output).toContain("model error");
  });

  it("validates output against JSON schema when provided", async () => {
    mockFind.mockReturnValue({ api: "openai", baseUrl: "https://api.test" });
    mockGetApiKey.mockResolvedValue("key-123");
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      cb({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: '{"name":"test"}' },
      });
      return vi.fn();
    });
    mockPrompt.mockResolvedValue(undefined);

    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: {
        prompt: { rendered: "hello" },
        execution: {
          backend: "pi",
          model: "prov/mod",
          outputSchemaJson: JSON.stringify({
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          }),
        },
      },
    } as never);
    expect(result.status).toBe("done");
  });

  it("fails when output does not match JSON schema", async () => {
    mockFind.mockReturnValue({ api: "openai", baseUrl: "https://api.test" });
    mockGetApiKey.mockResolvedValue("key-123");
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      cb({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: '{"wrong":"field"}' },
      });
      return vi.fn();
    });
    mockPrompt.mockResolvedValue(undefined);

    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: {
        prompt: { rendered: "hello" },
        execution: {
          backend: "pi",
          model: "prov/mod",
          outputSchemaJson: JSON.stringify({
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          }),
        },
      },
    } as never);
    expect(result.status).toBe("failed");
    expect(result.output).toContain("validation failed");
  });

  it("fails when outputSchemaJson is not valid JSON", async () => {
    mockFind.mockReturnValue({ api: "openai", baseUrl: "https://api.test" });
    mockGetApiKey.mockResolvedValue("key-123");
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      cb({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: '{"a":1}' },
      });
      return vi.fn();
    });
    mockPrompt.mockResolvedValue(undefined);

    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: {
        prompt: { rendered: "hello" },
        execution: { backend: "pi", model: "prov/mod", outputSchemaJson: "{bad json" },
      },
    } as never);
    expect(result.status).toBe("failed");
    expect(result.output).toContain("not valid JSON");
  });

  it("fails when output is not valid JSON but schema requires it", async () => {
    mockFind.mockReturnValue({ api: "openai", baseUrl: "https://api.test" });
    mockGetApiKey.mockResolvedValue("key-123");
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      cb({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "plain text, not json" },
      });
      return vi.fn();
    });
    mockPrompt.mockResolvedValue(undefined);

    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: {
        prompt: { rendered: "hello" },
        execution: {
          backend: "pi",
          model: "prov/mod",
          outputSchemaJson: JSON.stringify({ type: "object" }),
        },
      },
    } as never);
    expect(result.status).toBe("failed");
    expect(result.output).toContain("output is not valid JSON");
  });

  it("returns (empty response) when no output and not cancelled", async () => {
    mockFind.mockReturnValue({ api: "openai", baseUrl: "https://api.test" });
    mockGetApiKey.mockResolvedValue("key-123");
    mockSubscribe.mockReturnValue(vi.fn());
    mockPrompt.mockResolvedValue(undefined);

    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "t1", taskType: "demo", prompt: "", startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: { prompt: { rendered: "hello" }, execution: { backend: "pi", model: "prov/mod" } },
    } as never);
    expect(result.output).toBe("(empty response)");
  });

  it("uses FLUX_PI_AGENT_DIR env var", () => {
    const orig = process.env.FLUX_PI_AGENT_DIR;
    process.env.FLUX_PI_AGENT_DIR = "/custom/dir";
    const backend = new PiExecutionBackend();
    expect(backend.getAgentDir()).toBe("/custom/dir");
    if (orig === undefined) delete process.env.FLUX_PI_AGENT_DIR;
    else process.env.FLUX_PI_AGENT_DIR = orig;
  });
});
