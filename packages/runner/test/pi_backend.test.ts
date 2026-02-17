import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PiExecutionBackend } from "../src/pi_backend.ts";

describe("PiExecutionBackend", () => {
  it("only handles pi backend", () => {
    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    expect(backend.canExecute("pi")).toBe(true);
    expect(backend.canExecute("PI")).toBe(true);
    expect(backend.canExecute("claude-cli")).toBe(false);
  });

  it("fails preflight when models.json is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "flux-runner-pi-"));
    const backend = new PiExecutionBackend({ agentDir: dir });

    const result = await backend.preflight();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("models.json");
    }
  });

  it("passes preflight when models.json exists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "flux-runner-pi-"));
    await writeFile(path.join(dir, "models.json"), "{}", "utf8");
    const backend = new PiExecutionBackend({ agentDir: dir });

    const result = await backend.preflight();

    expect(result).toEqual({ ok: true });
  });

  it("fails execute when prompt.rendered is missing", async () => {
    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "task-1",
      taskType: "demo",
      prompt: "",
      startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: {
        execution: {
          backend: "pi",
          model: "provider/model",
        },
      },
    });

    expect(result.status).toBe("failed");
    expect(result.output).toContain("packet.prompt.rendered");
  });

  it("fails execute when execution.model is missing", async () => {
    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "task-1",
      taskType: "demo",
      prompt: "",
      startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: {
        prompt: {
          rendered: "hello",
        },
        execution: {
          backend: "pi",
        },
      },
    });

    expect(result.status).toBe("failed");
    expect(result.output).toContain("execution.model");
  });

  it("fails execute when execution.model is not provider/model", async () => {
    const backend = new PiExecutionBackend({ agentDir: "/tmp/agent" });
    const result = await backend.execute({
      taskId: "task-1",
      taskType: "demo",
      prompt: "",
      startedAt: Date.now(),
      abortSignal: new AbortController().signal,
      packet: {
        prompt: {
          rendered: "hello",
        },
        execution: {
          backend: "pi",
          model: "bad-model-format",
        },
      },
    });

    expect(result.status).toBe("failed");
    expect(result.output).toContain("Invalid execution.model");
  });
});
