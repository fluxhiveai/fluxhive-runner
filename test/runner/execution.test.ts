import { describe, expect, it } from "vitest";
import {
  normalizeExecutionBackend,
  packetInput,
  packetStreamId,
  packetTaskId,
  packetTaskType,
  renderPrompt,
  resolvePacketBackend,
} from "../../src/runner/execution.ts";
import type { McpTaskPacket } from "../../src/types.ts";

describe("execution helpers", () => {
  it("normalizes backend aliases", () => {
    expect(normalizeExecutionBackend(undefined)).toBeNull();
    expect(normalizeExecutionBackend("   ")).toBeNull();
    expect(normalizeExecutionBackend("claude")).toBe("claude-cli");
    expect(normalizeExecutionBackend("Claude-Code")).toBe("claude-cli");
    expect(normalizeExecutionBackend("codex")).toBe("codex-cli");
    expect(normalizeExecutionBackend("PI")).toBe("pi");
  });

  it("reads packet ids/types/stream/input from task first", () => {
    const packet: McpTaskPacket = {
      taskId: "fallback-task",
      type: "fallback-type",
      streamId: "fallback-stream",
      task: {
        id: "task-1",
        type: "conductor-chat",
        streamId: "stream-1",
        input: "payload",
      },
    };
    expect(packetTaskId(packet)).toBe("task-1");
    expect(packetTaskType(packet)).toBe("conductor-chat");
    expect(packetStreamId(packet)).toBe("stream-1");
    expect(packetInput(packet)).toBe("payload");
  });

  it("falls back to top-level packet metadata", () => {
    const packet: McpTaskPacket = {
      taskId: "task-2",
      type: "task-type",
      streamId: "stream-2",
    };
    expect(packetTaskId(packet)).toBe("task-2");
    expect(packetTaskType(packet)).toBe("task-type");
    expect(packetStreamId(packet)).toBe("stream-2");
  });

  it("prefers prompt.rendered for prompt generation", () => {
    const packet: McpTaskPacket = {
      prompt: {
        rendered: "hello from rendered",
      },
      promptPlan: {
        template: "ignored",
      },
    };
    expect(renderPrompt(packet)).toBe("hello from rendered");
  });

  it("renders fallback prompt from promptPlan/context/task", () => {
    const packet: McpTaskPacket = {
      promptPlan: {
        template: "TEMPLATE",
        vars: { a: 1 },
      },
      context: { b: 2 },
      task: { id: "task-3", type: "demo" },
    };
    const prompt = renderPrompt(packet);
    expect(prompt).toContain("TEMPLATE");
    expect(prompt).toContain('"a": 1');
    expect(prompt).toContain('"b": 2');
    expect(prompt).toContain('"id": "task-3"');
  });

  it("resolves backend with precedence execution > prompt > fallback > default", () => {
    const packetWithExecution: McpTaskPacket = {
      execution: { backend: "pi" },
      prompt: { backend: "codex" },
    };
    expect(resolvePacketBackend(packetWithExecution, "claude-code")).toBe("pi");

    const packetWithPrompt: McpTaskPacket = {
      prompt: { backend: "codex" },
    };
    expect(resolvePacketBackend(packetWithPrompt, "claude")).toBe("codex-cli");

    const packetFallback: McpTaskPacket = {};
    expect(resolvePacketBackend(packetFallback, "claude-code")).toBe("claude-cli");
    expect(resolvePacketBackend(packetFallback)).toBe("claude-cli");
  });
});
