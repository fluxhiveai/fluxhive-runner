import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockWhoami = vi.fn();
const mockAccessRedeem = vi.fn();
const mockAccessRequest = vi.fn();
const mockAccessPoll = vi.fn();

vi.mock("../../src/client.js", () => ({
  FluxApiClient: vi.fn().mockImplementation(() => ({
    whoami: mockWhoami,
    accessRedeem: mockAccessRedeem,
    accessRequest: mockAccessRequest,
    accessPoll: mockAccessPoll,
  })),
}));

vi.mock("../../src/config.js", () => ({
  resolveConfig: vi.fn(() => ({
    host: "https://flux.test",
    token: "tok-test",
    mcpBase: "https://flux.test/mcp/v1",
  })),
  writeConfigFile: vi.fn(),
  getConfigFilePath: vi.fn(() => "/home/user/.flux/config.json"),
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

const { registerAuthCommands } = await import("../../src/commands/auth.ts");
const { writeConfigFile } = await import("../../src/config.js");

function makeProgram() {
  const program = new Command();
  program.option("--json").option("--host <url>").option("--token <token>");
  registerAuthCommands(program);
  program.exitOverride();
  return program;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("whoami command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("outputs JSON in json mode", async () => {
    const res = { agent: { name: "a", slug: "s", id: "1" }, server: { version: "v1" } };
    mockWhoami.mockResolvedValue(res);
    await makeProgram().parseAsync(["node", "fluxhive", "whoami", "--json"]);
    expect(mockJson).toHaveBeenCalledWith(res);
  });

  it("outputs key-value in normal mode", async () => {
    mockWhoami.mockResolvedValue({
      agent: { name: "Agent", slug: "agent", id: "id-1" },
      server: { version: "v2" },
    });
    await makeProgram().parseAsync(["node", "fluxhive", "whoami"]);
    expect(mockKeyValue).toHaveBeenCalled();
    expect(mockJson).not.toHaveBeenCalled();
  });

  it("handles errors", async () => {
    mockWhoami.mockRejectedValue(new Error("network fail"));
    await expect(
      makeProgram().parseAsync(["node", "fluxhive", "whoami"]),
    ).rejects.toThrow();
    expect(mockError).toHaveBeenCalledWith("network fail");
  });
});

describe("access redeem command", () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FLUX_HOST = "https://flux.test";
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("redeems invite and writes config in json mode", async () => {
    mockAccessRedeem.mockResolvedValue({
      credentials: { token: "t", orgId: "o", agentName: "a", agentSlug: "s" },
    });
    await makeProgram().parseAsync([
      "node", "fluxhive", "access", "redeem",
      "--invite", "inv-1", "--org", "org-1", "--json",
    ]);
    expect(mockAccessRedeem).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", inviteCode: "inv-1" }),
    );
    expect(writeConfigFile).toHaveBeenCalled();
    expect(mockJson).toHaveBeenCalled();
  });

  it("redeems invite in normal mode", async () => {
    mockAccessRedeem.mockResolvedValue({
      credentials: { token: "t", orgId: "o", agentName: "a", agentSlug: "s" },
    });
    await makeProgram().parseAsync([
      "node", "fluxhive", "access", "redeem",
      "--invite", "inv-1", "--org", "org-1",
    ]);
    expect(mockKeyValue).toHaveBeenCalled();
    expect(writeConfigFile).toHaveBeenCalled();
  });

  it("errors when no host configured", async () => {
    delete process.env.FLUX_HOST;
    await expect(
      makeProgram().parseAsync([
        "node", "fluxhive", "access", "redeem",
        "--invite", "i", "--org", "o",
      ]),
    ).rejects.toThrow();
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining("host"));
  });
});

describe("access request command", () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FLUX_HOST = "https://flux.test";
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("submits request in json mode", async () => {
    mockAccessRequest.mockResolvedValue({
      requestId: "r1", status: "pending", pollSecret: "s1",
    });
    await makeProgram().parseAsync([
      "node", "fluxhive", "access", "request",
      "--invite", "inv", "--org", "org", "--json",
    ]);
    expect(mockAccessRequest).toHaveBeenCalled();
    expect(mockJson).toHaveBeenCalled();
  });

  it("submits request in normal mode", async () => {
    mockAccessRequest.mockResolvedValue({
      requestId: "r1", status: "pending", pollSecret: "s1",
    });
    await makeProgram().parseAsync([
      "node", "fluxhive", "access", "request",
      "--invite", "inv", "--org", "org",
    ]);
    expect(mockKeyValue).toHaveBeenCalled();
  });
});

describe("access poll command", () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FLUX_HOST = "https://flux.test";
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("polls and saves credentials when granted", async () => {
    mockAccessPoll.mockResolvedValue({
      status: "approved",
      credentials: { token: "t", orgId: "o", agentName: "a" },
    });
    await makeProgram().parseAsync([
      "node", "fluxhive", "access", "poll",
      "--id", "r1", "--secret", "s1",
    ]);
    expect(writeConfigFile).toHaveBeenCalled();
    expect(mockKeyValue).toHaveBeenCalled();
  });

  it("polls pending (no credentials)", async () => {
    mockAccessPoll.mockResolvedValue({ status: "pending" });
    await makeProgram().parseAsync([
      "node", "fluxhive", "access", "poll",
      "--id", "r1", "--secret", "s1",
    ]);
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("outputs json in json mode", async () => {
    mockAccessPoll.mockResolvedValue({ status: "pending" });
    await makeProgram().parseAsync([
      "node", "fluxhive", "access", "poll",
      "--id", "r1", "--secret", "s1", "--json",
    ]);
    expect(mockJson).toHaveBeenCalled();
  });
});
