import { describe, expect, it, vi, beforeEach } from "vitest";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockHealth = vi.fn();
const mockOpenapi = vi.fn();

vi.mock("../../src/client.js", () => ({
  FluxApiClient: vi.fn().mockImplementation(() => ({
    health: mockHealth,
    openapi: mockOpenapi,
  })),
}));

vi.mock("../../src/config.js", () => ({
  resolveConfig: vi.fn(() => ({
    host: "https://flux.test",
    token: "tok-abcdef1234567890",
    orgId: "org-1",
    mcpBase: "https://flux.test/mcp/v1",
  })),
  getConfigFilePath: vi.fn(() => "/home/.flux/config.json"),
  getConfigDir: vi.fn(() => "/home/.flux"),
}));

const mockJson = vi.fn();
const mockKeyValue = vi.fn();
const mockError = vi.fn((): never => {
  throw new Error("process.exit");
});
vi.mock("../../src/output.js", () => ({
  json: (...args: unknown[]) => mockJson(...args),
  keyValue: (...args: unknown[]) => mockKeyValue(...args),
  error: (...args: unknown[]) => mockError(...args),
  bold: (t: string) => t,
  dim: (t: string) => t,
  green: (t: string) => t,
  red: (t: string) => t,
}));

const { registerConfigCommands } = await import("../../src/commands/config-cmd.ts");

function makeProgram() {
  const program = new Command();
  program.option("--json").option("--host <url>").option("--token <token>");
  registerConfigCommands(program);
  program.exitOverride();
  return program;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("health command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows healthy status in json mode", async () => {
    mockHealth.mockResolvedValue({ ok: true, version: "v1" });
    await makeProgram().parseAsync(["node", "fluxhive", "health", "--json"]);
    expect(mockJson).toHaveBeenCalledWith({ ok: true, version: "v1" });
  });

  it("shows healthy status in normal mode", async () => {
    mockHealth.mockResolvedValue({ ok: true, version: "v1" });
    await makeProgram().parseAsync(["node", "fluxhive", "health"]);
    expect(mockKeyValue).toHaveBeenCalled();
  });

  it("shows unhealthy status in normal mode", async () => {
    mockHealth.mockResolvedValue({ ok: false });
    await makeProgram().parseAsync(["node", "fluxhive", "health"]);
    expect(mockJson).not.toHaveBeenCalled();
  });

  it("handles errors", async () => {
    mockHealth.mockRejectedValue(new Error("timeout"));
    await expect(
      makeProgram().parseAsync(["node", "fluxhive", "health"]),
    ).rejects.toThrow();
    expect(mockError).toHaveBeenCalledWith("timeout");
  });
});

describe("config command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("outputs json in json mode", async () => {
    await makeProgram().parseAsync(["node", "fluxhive", "config", "--json"]);
    expect(mockJson).toHaveBeenCalledWith(
      expect.objectContaining({ host: "https://flux.test", tokenSet: true }),
    );
  });

  it("outputs key-value in normal mode", async () => {
    await makeProgram().parseAsync(["node", "fluxhive", "config"]);
    expect(mockKeyValue).toHaveBeenCalled();
  });
});

describe("openapi command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("always outputs json", async () => {
    mockOpenapi.mockResolvedValue({ openapi: "3.0" });
    await makeProgram().parseAsync(["node", "fluxhive", "openapi"]);
    expect(mockJson).toHaveBeenCalledWith({ openapi: "3.0" });
  });

  it("handles errors", async () => {
    mockOpenapi.mockRejectedValue(new Error("nope"));
    await expect(
      makeProgram().parseAsync(["node", "fluxhive", "openapi"]),
    ).rejects.toThrow();
    expect(mockError).toHaveBeenCalledWith("nope");
  });
});
