import { describe, expect, it, vi, beforeEach } from "vitest";
import { Command } from "commander";

const mockListTasks = vi.fn();
const mockCreateTask = vi.fn();

vi.mock("../../src/client.js", () => ({
  FluxApiClient: vi.fn().mockImplementation(() => ({
    listTasks: mockListTasks,
    createTask: mockCreateTask,
  })),
}));

vi.mock("../../src/config.js", () => ({
  resolveConfig: vi.fn(() => ({
    host: "https://flux.test",
    token: "tok-test",
    mcpBase: "https://flux.test/mcp/v1",
  })),
}));

const mockJson = vi.fn();
const mockTable = vi.fn();
const mockKeyValue = vi.fn();
const mockError = vi.fn((): never => {
  throw new Error("process.exit");
});
vi.mock("../../src/output.js", () => ({
  json: (...args: unknown[]) => mockJson(...args),
  table: (...args: unknown[]) => mockTable(...args),
  keyValue: (...args: unknown[]) => mockKeyValue(...args),
  error: (...args: unknown[]) => mockError(...args),
  bold: (t: string) => t,
  dim: (t: string) => t,
  green: (t: string) => t,
  truncate: (t: string, n: number) => t.slice(0, n),
}));

const { registerTaskCommands } = await import("../../src/commands/tasks.ts");

function makeProgram() {
  const program = new Command();
  program.option("--json").option("--host <url>").option("--token <token>");
  registerTaskCommands(program);
  program.exitOverride();
  return program;
}

describe("tasks list command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("outputs json in json mode", async () => {
    const res = { tasks: [{ _id: "1", status: "todo", type: "demo" }] };
    mockListTasks.mockResolvedValue(res);
    await makeProgram().parseAsync(["node", "fluxhive", "tasks", "list", "--json"]);
    expect(mockJson).toHaveBeenCalledWith(res);
  });

  it("outputs table in normal mode", async () => {
    mockListTasks.mockResolvedValue({
      tasks: [{ _id: "1", status: "todo", type: "demo", goal: "Test" }],
    });
    await makeProgram().parseAsync(["node", "fluxhive", "tasks", "list"]);
    expect(mockTable).toHaveBeenCalled();
  });

  it("handles empty tasks", async () => {
    mockListTasks.mockResolvedValue({ tasks: [] });
    await makeProgram().parseAsync(["node", "fluxhive", "tasks", "list"]);
    expect(mockTable).not.toHaveBeenCalled();
  });

  it("forwards filter options", async () => {
    mockListTasks.mockResolvedValue({ tasks: [] });
    await makeProgram().parseAsync([
      "node", "fluxhive", "tasks", "list",
      "--status", "doing", "--limit", "5", "--backend", "pi",
    ]);
    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({ status: "doing", limit: 5, backend: "pi" }),
    );
  });

  it("handles task objects with nested task field", async () => {
    mockListTasks.mockResolvedValue({
      tasks: [{ task: { id: "t1", type: "x", goal: "g", streamId: "s" }, status: "todo" }],
    });
    await makeProgram().parseAsync(["node", "fluxhive", "tasks", "list"]);
    expect(mockTable).toHaveBeenCalled();
  });
});

describe("tasks create command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates task in json mode", async () => {
    mockCreateTask.mockResolvedValue({ taskId: "new-1" });
    await makeProgram().parseAsync([
      "node", "fluxhive", "tasks", "create",
      "--goal", "Do thing", "--input", "data", "--json",
    ]);
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "Do thing", input: "data", type: "general" }),
    );
    expect(mockJson).toHaveBeenCalledWith({ taskId: "new-1" });
  });

  it("creates task in normal mode", async () => {
    mockCreateTask.mockResolvedValue({ taskId: "new-2" });
    await makeProgram().parseAsync([
      "node", "fluxhive", "tasks", "create",
      "--goal", "Do", "--input", "x",
    ]);
    expect(mockKeyValue).toHaveBeenCalled();
  });

  it("forwards optional options", async () => {
    mockCreateTask.mockResolvedValue({ taskId: "new-3" });
    await makeProgram().parseAsync([
      "node", "fluxhive", "tasks", "create",
      "--goal", "G", "--input", "I",
      "--type", "special", "--backend", "pi", "--model", "a/b", "--priority", "5",
    ]);
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "special",
        executionBackend: "pi",
        executionModel: "a/b",
        priority: 5,
      }),
    );
  });
});
