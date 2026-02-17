import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAppendFileSync = vi.fn();

vi.mock("node:fs", () => ({
  appendFileSync: (...args: unknown[]) => mockAppendFileSync(...args),
}));

describe("flux-log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes structured sections with metadata to /tmp/flux.log", async () => {
    const { appendFluxLog } = await import("./flux-log.js");
    appendFluxLog({
      stage: "INPUT",
      metadata: {
        taskId: "task-123",
        taskType: "operator",
        model: "claude-haiku",
      },
      sections: [{ label: "PROMPT", content: "hello world" }],
    });

    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    const [path, payload] = mockAppendFileSync.mock.calls[0] as [string, string];
    expect(path).toBe("/tmp/flux.log");
    expect(payload).toContain("FLUX INPUT");
    expect(payload).toContain("taskId: task-123");
    expect(payload).toContain("taskType: operator");
    expect(payload).toContain("model: claude-haiku");
    expect(payload).toContain("PROMPT:");
    expect(payload).toContain("hello world");
  });

  it("renders empty section content as a readable placeholder", async () => {
    const { appendFluxLog } = await import("./flux-log.js");
    appendFluxLog({
      stage: "OUTPUT",
      metadata: { taskId: "task-2" },
      sections: [{ label: "RETURNED_OUTPUT", content: "   " }],
    });

    const [, payload] = mockAppendFileSync.mock.calls[0] as [string, string];
    expect(payload).toContain("FLUX OUTPUT");
    expect(payload).toContain("RETURNED_OUTPUT:");
    expect(payload).toContain("(empty)");
  });

  it("swallows file write errors", async () => {
    mockAppendFileSync.mockImplementation(() => {
      throw new Error("disk full");
    });
    const { appendFluxLog } = await import("./flux-log.js");

    expect(() =>
      appendFluxLog({
        stage: "ERROR",
        metadata: { taskId: "task-3" },
        sections: [{ label: "ERROR_OUTPUT", content: "oops" }],
      }),
    ).not.toThrow();
  });
});
