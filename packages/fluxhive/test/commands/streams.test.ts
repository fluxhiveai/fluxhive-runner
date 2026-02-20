import { describe, expect, it, vi, beforeEach } from "vitest";
import { Command } from "commander";

const mockListStreams = vi.fn();

vi.mock("../../src/client.js", () => ({
  FluxApiClient: vi.fn().mockImplementation(() => ({
    listStreams: mockListStreams,
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
const mockError = vi.fn((): never => {
  throw new Error("process.exit");
});
vi.mock("../../src/output.js", () => ({
  json: (...args: unknown[]) => mockJson(...args),
  table: (...args: unknown[]) => mockTable(...args),
  error: (...args: unknown[]) => mockError(...args),
  bold: (t: string) => t,
  dim: (t: string) => t,
  truncate: (t: string, n: number) => t.slice(0, n),
}));

const { registerStreamCommands } = await import("../../src/commands/streams.ts");

function makeProgram() {
  const program = new Command();
  program.option("--json").option("--host <url>").option("--token <token>");
  registerStreamCommands(program);
  program.exitOverride();
  return program;
}

describe("streams list command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("outputs json in json mode", async () => {
    const res = { streams: [{ _id: "s1", title: "S", slug: "s", status: "active" }] };
    mockListStreams.mockResolvedValue(res);
    await makeProgram().parseAsync(["node", "fluxhive", "streams", "list", "--json"]);
    expect(mockJson).toHaveBeenCalledWith(res);
  });

  it("outputs table in normal mode", async () => {
    mockListStreams.mockResolvedValue({
      streams: [{ _id: "s1", title: "S", slug: "s", status: "active", horizon: "2d" }],
    });
    await makeProgram().parseAsync(["node", "fluxhive", "streams", "list"]);
    expect(mockTable).toHaveBeenCalled();
  });

  it("handles empty streams", async () => {
    mockListStreams.mockResolvedValue({ streams: [] });
    await makeProgram().parseAsync(["node", "fluxhive", "streams", "list"]);
    expect(mockTable).not.toHaveBeenCalled();
  });

  it("forwards status filter", async () => {
    mockListStreams.mockResolvedValue({ streams: [] });
    await makeProgram().parseAsync([
      "node", "fluxhive", "streams", "list", "--status", "paused",
    ]);
    expect(mockListStreams).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused" }),
    );
  });

  it("handles streams with missing optional fields", async () => {
    mockListStreams.mockResolvedValue({
      streams: [{ id: "s2" }],
    });
    await makeProgram().parseAsync(["node", "fluxhive", "streams", "list"]);
    expect(mockTable).toHaveBeenCalled();
  });
});
