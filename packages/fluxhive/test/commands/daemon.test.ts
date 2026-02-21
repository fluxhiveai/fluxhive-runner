import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock all heavy dependencies so we can test daemon startup logic
// ---------------------------------------------------------------------------

const mockLoadRunnerConfig = vi.fn();
const mockFetchSkillManifest = vi.fn();
const mockWhoami = vi.fn();
const mockHandshake = vi.fn();
const mockHello = vi.fn();
const mockPing = vi.fn();
const mockPreflight = vi.fn();
const mockPushStart = vi.fn();
const mockPushOn = vi.fn();
const mockCadenceStart = vi.fn();
const mockCadenceStop = vi.fn();
const mockCadenceTriggerNow = vi.fn();
const mockPushStop = vi.fn();
const mockOpenclawClose = vi.fn();
const mockOpenclawExecute = vi.fn();
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();

vi.mock("node:fs", () => ({
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
}));

vi.mock("../../src/runner/config.js", () => ({
  loadRunnerConfig: () => mockLoadRunnerConfig(),
  fetchSkillManifest: (...args: unknown[]) => mockFetchSkillManifest(...args),
}));

vi.mock("../../src/runner/client.js", () => ({
  FluxMcpClient: vi.fn().mockImplementation(() => ({
    whoami: mockWhoami,
    handshake: mockHandshake,
    hello: mockHello,
  })),
}));

vi.mock("../../src/runner/openclaw.js", () => ({
  OpenClawClient: vi.fn().mockImplementation(() => ({
    ping: mockPing,
    close: mockOpenclawClose,
    execute: mockOpenclawExecute,
  })),
}));

vi.mock("../../src/runner/push.js", () => ({
  FluxPushClient: vi.fn().mockImplementation(() => ({
    start: mockPushStart,
    stop: mockPushStop,
    on: mockPushOn,
  })),
}));

vi.mock("../../src/runner/executor.js", () => ({
  TaskExecutor: vi.fn(),
}));

vi.mock("../../src/runner/cadence.js", () => ({
  CadenceLoop: vi.fn().mockImplementation(() => ({
    start: mockCadenceStart,
    stop: mockCadenceStop,
    triggerNow: mockCadenceTriggerNow,
  })),
}));

vi.mock("../../src/runner/openclaw_backend.js", () => ({
  OpenClawExecutionBackend: vi.fn(),
}));

vi.mock("../../src/runner/pi_backend.js", () => ({
  PiExecutionBackend: vi.fn().mockImplementation(() => ({
    preflight: mockPreflight,
    getAgentDir: () => "/tmp/pi",
  })),
}));

vi.mock("../../src/runner/claude_cli_backend.js", () => ({
  ClaudeCliExecutionBackend: vi.fn(),
}));

// We need access to the private normalizeWsUrl and log, but they're module-private.
// We'll test them indirectly through runDaemon or test the registerDaemonCommand path.

const { registerDaemonCommand } = await import("../../src/commands/daemon.ts");

function baseConfig() {
  return {
    fluxHost: "https://flux.test",
    fluxMcpBase: "https://flux.test/mcp/v1",
    fluxToken: "tok",
    fluxOrgId: "org-1",
    skillManifestUrl: "",
    skillManifestBody: "---\nprotocolVersion: \"1\"\norgId: org-1\n---\n# Test SKILL.md\n",
    skillManifestFrontmatter: { mcpPushWs: null, updatedAt: "2026-02-20" },
    runnerType: "test",
    runnerVersion: "1.0",
    runnerInstanceId: "inst-1",
    machineId: "mach-1",
    cadenceMinutes: 1,
    pushReconnectMs: 5000,
    openclawGatewayUrl: "",
    openclawGatewayToken: "",
    openclawGatewayPassword: "",
    openclawAgentId: "",
  };
}

function setupDefaults() {
  mockLoadRunnerConfig.mockResolvedValue(baseConfig());
  mockWhoami.mockResolvedValue({
    agent: { id: "a1", slug: "a" },
    server: { version: "v1" },
  });
  mockHandshake.mockResolvedValue({
    agentId: "a1",
    agentName: "Agent",
    config: { push: { mode: "polling" }, maxBatchSize: 5 },
  });
  mockHello.mockResolvedValue({});
  mockPreflight.mockResolvedValue({ ok: false, reason: "no models.json" });
}

describe("daemon command", () => {
  const origEnv = { ...process.env };
  const origExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
    process.env = { ...origEnv };
    delete process.env.FLUX_BACKEND;
    delete process.env.FLUX_ALLOW_DIRECT_CLI;
  });

  afterEach(() => {
    process.exit = origExit;
    process.env = { ...origEnv };
  });

  it("registerDaemonCommand registers the daemon command", () => {
    const program = new Command();
    registerDaemonCommand(program);
    const cmd = program.commands.find((c) => c.name() === "daemon");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("runner daemon");
  });

  it("daemon command catches errors and calls process.exit(1)", async () => {
    mockLoadRunnerConfig.mockRejectedValue(new Error("config fail"));
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;

    const program = new Command();
    registerDaemonCommand(program);
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "fluxhive", "daemon"]),
    ).rejects.toThrow();
    expect(exitCode).toBe(1);
  });

  it("throws when no execution backend registered", async () => {
    // FLUX_ALLOW_DIRECT_CLI is unset, openclaw is not configured, PI preflight fails
    // and FLUX_BACKEND is unset — all backends will be skipped or disabled
    mockPreflight.mockResolvedValue({ ok: false, reason: "no models" });

    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;

    const program = new Command();
    registerDaemonCommand(program);
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "fluxhive", "daemon"]),
    ).rejects.toThrow();
    expect(exitCode).toBe(1);
  });

  it("starts with PI backend when preflight passes", async () => {
    mockPreflight.mockResolvedValue({ ok: true });

    // The daemon waits indefinitely via `new Promise(() => {})`, so we need it to
    // error out eventually. Let cadenceStart throw to break the loop.
    mockCadenceStart.mockImplementation(() => {
      throw new Error("break");
    });

    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;

    const program = new Command();
    registerDaemonCommand(program);
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "fluxhive", "daemon"]),
    ).rejects.toThrow();
    // It should have gotten past backend init
    expect(mockPreflight).toHaveBeenCalled();
  });

  it("enables claude-cli when FLUX_ALLOW_DIRECT_CLI=1", async () => {
    process.env.FLUX_ALLOW_DIRECT_CLI = "1";
    mockPreflight.mockResolvedValue({ ok: false, reason: "nope" });

    mockCadenceStart.mockImplementation(() => {
      throw new Error("break");
    });

    process.exit = ((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never;

    const program = new Command();
    registerDaemonCommand(program);
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "fluxhive", "daemon"]),
    ).rejects.toThrow();
    // Should have gotten past backend registration
    expect(mockCadenceStart).toHaveBeenCalled();
  });

  it("enables openclaw backend when gateway URL configured and ping succeeds", async () => {
    const config = baseConfig();
    config.openclawGatewayUrl = "ws://localhost:18789";
    config.openclawGatewayToken = "oc-tok";
    config.openclawAgentId = "oc-agent";
    mockLoadRunnerConfig.mockResolvedValue(config);
    mockPing.mockResolvedValue(true);
    mockPreflight.mockResolvedValue({ ok: false, reason: "no models" });

    mockCadenceStart.mockImplementation(() => {
      throw new Error("break");
    });

    process.exit = ((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never;

    const program = new Command();
    registerDaemonCommand(program);
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "fluxhive", "daemon"]),
    ).rejects.toThrow();
    expect(mockPing).toHaveBeenCalled();
    expect(mockCadenceStart).toHaveBeenCalled();
  });

  it("disables openclaw when ping fails", async () => {
    const config = baseConfig();
    config.openclawGatewayUrl = "ws://localhost:18789";
    mockLoadRunnerConfig.mockResolvedValue(config);
    mockPing.mockResolvedValue(false);
    mockPreflight.mockResolvedValue({ ok: false, reason: "no models" });

    process.exit = ((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never;

    const program = new Command();
    registerDaemonCommand(program);
    program.exitOverride();

    // Should fail because no backends are available
    await expect(
      program.parseAsync(["node", "fluxhive", "daemon"]),
    ).rejects.toThrow();
    expect(mockOpenclawClose).toHaveBeenCalled();
  });

  it("starts push client when WS URL is available", async () => {
    mockPreflight.mockResolvedValue({ ok: true });
    mockHandshake.mockResolvedValue({
      agentId: "a1",
      agentName: "Agent",
      config: {
        push: { mode: "push", wsUrl: "wss://push.flux.test/ws" },
        maxBatchSize: 5,
      },
    });
    mockPushStart.mockResolvedValue(undefined);

    mockCadenceStart.mockImplementation(() => {
      throw new Error("break");
    });

    process.exit = ((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never;

    const program = new Command();
    registerDaemonCommand(program);
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "fluxhive", "daemon"]),
    ).rejects.toThrow();
    expect(mockPushStart).toHaveBeenCalled();
    expect(mockPushOn).toHaveBeenCalledWith("connected", expect.any(Function));
    expect(mockPushOn).toHaveBeenCalledWith("task.available", expect.any(Function));
  });

  it("converts http URL to ws for push client", async () => {
    const config = baseConfig();
    config.skillManifestFrontmatter = { mcpPushWs: "https://push.flux.test/ws" };
    mockLoadRunnerConfig.mockResolvedValue(config);
    mockPreflight.mockResolvedValue({ ok: true });
    mockHandshake.mockResolvedValue({
      agentId: "a1",
      agentName: "Agent",
      config: { push: { mode: "push" }, maxBatchSize: 5 },
    });
    mockPushStart.mockResolvedValue(undefined);
    mockCadenceStart.mockImplementation(() => {
      throw new Error("break");
    });

    process.exit = ((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never;

    const program = new Command();
    registerDaemonCommand(program);
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "fluxhive", "daemon"]),
    ).rejects.toThrow();
    expect(mockPushStart).toHaveBeenCalled();
  });

  it("throws when FLUX_BACKEND=pi and PI preflight fails", async () => {
    process.env.FLUX_BACKEND = "pi";
    mockPreflight.mockResolvedValue({ ok: false, reason: "no models" });

    process.exit = ((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never;

    const program = new Command();
    registerDaemonCommand(program);
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "fluxhive", "daemon"]),
    ).rejects.toThrow();
  });

  it("handles hello failure gracefully", async () => {
    mockHello.mockRejectedValue(new Error("not found"));
    mockPreflight.mockResolvedValue({ ok: true });
    mockCadenceStart.mockImplementation(() => {
      throw new Error("break");
    });

    process.exit = ((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never;

    const program = new Command();
    registerDaemonCommand(program);
    program.exitOverride();

    // Should not throw from hello — it logs a warning and continues past it
    // to cadenceStart, which throws "break", caught by daemon's error handler
    await expect(
      program.parseAsync(["node", "fluxhive", "daemon"]),
    ).rejects.toThrow();
    // The key assertion: cadenceStart was reached, meaning hello didn't block
    expect(mockCadenceStart).toHaveBeenCalled();
  });

  it("saves initial SKILL.md to ~/.flux/SKILL.md on startup", async () => {
    mockPreflight.mockResolvedValue({ ok: true });
    mockCadenceStart.mockImplementation(() => {
      throw new Error("break");
    });

    process.exit = ((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never;

    const program = new Command();
    registerDaemonCommand(program);
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "fluxhive", "daemon"]),
    ).rejects.toThrow();

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(".flux"),
      { recursive: true },
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("SKILL.md"),
      expect.stringContaining("# Test SKILL.md"),
      "utf8",
    );
  });
});
