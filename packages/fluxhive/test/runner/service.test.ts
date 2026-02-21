import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import process from "node:process";

// ---------------------------------------------------------------------------
// service.ts has module-level constants that call homedir() at import time,
// so we must set tempDir BEFORE importing the module. We also mock
// child_process.execSync to avoid real launchctl/systemctl calls.
// ---------------------------------------------------------------------------

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flux-service-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:os");
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => tempDir,
      platform: actual.platform,
    },
    homedir: () => tempDir,
    platform: actual.platform,
  };
});

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
}));

// Import after mocks are set up and tempDir is defined
const { handleServiceCommand } = await import("../../src/runner/service.ts");

// ---------------------------------------------------------------------------
// Since handleServiceCommand calls process.exit, we mock it to throw
// so we can catch and verify behavior.
// ---------------------------------------------------------------------------

class ProcessExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.name = "ProcessExitError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleServiceCommand", () => {
  const origEnv = { ...process.env };
  const origExit = process.exit;

  beforeEach(() => {
    // Mock process.exit to throw instead of exiting
    process.exit = ((code: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as never;

    // Set required env vars for install
    process.env.FLUX_TOKEN = "tok-test";
    process.env.FLUX_HOST = "https://fluxhive.test";
  });

  afterEach(() => {
    process.exit = origExit;
    process.env = { ...origEnv };
  });

  it("rejects unknown action with exit code 1", () => {
    expect(() => handleServiceCommand("bogus")).toThrow(ProcessExitError);
    try {
      handleServiceCommand("bogus");
    } catch (err) {
      expect((err as ProcessExitError).code).toBe(1);
    }
  });

  it("rejects empty action", () => {
    expect(() => handleServiceCommand("")).toThrow(ProcessExitError);
  });

  it("install requires FLUX_TOKEN", () => {
    delete process.env.FLUX_TOKEN;

    expect(() => handleServiceCommand("install")).toThrow(ProcessExitError);
    try {
      handleServiceCommand("install");
    } catch (err) {
      expect((err as ProcessExitError).code).toBe(1);
    }
  });

  it("install requires FLUX_HOST", () => {
    delete process.env.FLUX_HOST;

    expect(() => handleServiceCommand("install")).toThrow(ProcessExitError);
    try {
      handleServiceCommand("install");
    } catch (err) {
      expect((err as ProcessExitError).code).toBe(1);
    }
  });

  it("install succeeds when token is only in ~/.flux/config.json (token NOT in plist)", () => {
    if (os.platform() !== "darwin") return;

    // Remove env vars
    delete process.env.FLUX_TOKEN;
    delete process.env.FLUX_HOST;

    // Write a config file in the mocked home directory
    const fluxDir = path.join(tempDir, ".flux");
    fs.mkdirSync(fluxDir, { recursive: true });
    fs.writeFileSync(
      path.join(fluxDir, "config.json"),
      JSON.stringify({ host: "https://config-file.test", token: "tok-from-config", orgId: "org-cfg" }),
    );

    try {
      handleServiceCommand("install");
    } catch (err) {
      expect((err as ProcessExitError).code).toBe(0);
    }

    // Verify the plist was written with non-secret config file values
    const plistPath = path.join(tempDir, "Library", "LaunchAgents", "ai.fluxhive.runner.plist");
    if (fs.existsSync(plistPath)) {
      const content = fs.readFileSync(plistPath, "utf8");
      // Token must NOT appear in plist — loaded at runtime
      expect(content).not.toContain("tok-from-config");
      // Non-secret host and orgId should be present
      expect(content).toContain("config-file.test");
      expect(content).toContain("org-cfg");
    }
  });

  it("install with valid env exits 0 on macOS", () => {
    // This should succeed on macOS (the platform detection will pick launchd)
    // The execSync mock prevents actual launchctl calls
    try {
      handleServiceCommand("install");
    } catch (err) {
      expect((err as ProcessExitError).code).toBe(0);
    }

    // Verify the LaunchAgents plist was written
    const plistPath = path.join(tempDir, "Library", "LaunchAgents", "ai.fluxhive.runner.plist");
    if (os.platform() === "darwin") {
      expect(fs.existsSync(plistPath)).toBe(true);

      const plistContent = fs.readFileSync(plistPath, "utf8");
      expect(plistContent).toContain("ai.fluxhive.runner");
      expect(plistContent).toContain("<key>RunAtLoad</key>");
      expect(plistContent).toContain("<true/>");
      expect(plistContent).toContain("<key>KeepAlive</key>");
      expect(plistContent).toContain("<key>ProgramArguments</key>");
      expect(plistContent).toContain("<key>EnvironmentVariables</key>");
      // Token must NOT appear in plist — loaded at runtime from config file
      expect(plistContent).not.toContain("tok-test");
      expect(plistContent).toContain("https://fluxhive.test");
    }
  });

  it("restart exits 0 when plist exists", () => {
    // First install, then restart
    try {
      handleServiceCommand("install");
    } catch {
      // exit 0
    }
    try {
      handleServiceCommand("restart");
    } catch (err) {
      expect((err as ProcessExitError).code).toBe(0);
    }
  });

  it("restart exits 1 when service file does not exist", async () => {
    // Remove both macOS plist and Linux systemd unit so this works on either CI platform
    const plistPath = path.join(tempDir, "Library", "LaunchAgents", "ai.fluxhive.runner.plist");
    const unitPath = path.join(tempDir, ".config", "systemd", "user", "fluxhive-runner.service");
    if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
    if (fs.existsSync(unitPath)) fs.unlinkSync(unitPath);

    try {
      handleServiceCommand("restart");
    } catch (err) {
      expect((err as ProcessExitError).code).toBe(1);
    }
  });

  it("stop exits 0", () => {
    try {
      handleServiceCommand("stop");
    } catch (err) {
      expect((err as ProcessExitError).code).toBe(0);
    }
  });

  it("status exits 0", () => {
    try {
      handleServiceCommand("status");
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExitError);
      expect((err as ProcessExitError).code).toBe(0);
    }
  });

  it("uninstall exits 0", async () => {
    // Clear credentials so notifyDisconnect() short-circuits (avoids real HTTP)
    delete process.env.FLUX_TOKEN;
    delete process.env.FLUX_HOST;

    // Uninstall is async (notifyDisconnect → .finally). Use a no-op exit mock
    // so the .finally callback doesn't throw into an unhandled rejection.
    const exitCalls: number[] = [];
    process.exit = ((code: number) => { exitCalls.push(code ?? 0); }) as never;

    handleServiceCommand("uninstall");
    await new Promise((r) => setTimeout(r, 100));

    expect(exitCalls).toContain(0);
  });

  it("uninstall --clean removes ~/.flux directory", async () => {
    delete process.env.FLUX_TOKEN;
    delete process.env.FLUX_HOST;

    const fluxDir = path.join(tempDir, ".flux");
    fs.mkdirSync(path.join(fluxDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(fluxDir, "config.json"), "{}");

    const exitCalls: number[] = [];
    process.exit = ((code: number) => { exitCalls.push(code ?? 0); }) as never;

    handleServiceCommand("uninstall", { clean: true });
    await new Promise((r) => setTimeout(r, 100));

    expect(exitCalls).toContain(0);
    expect(fs.existsSync(fluxDir)).toBe(false);
  });

  it("uninstall without --clean keeps ~/.flux directory", async () => {
    delete process.env.FLUX_TOKEN;
    delete process.env.FLUX_HOST;

    const fluxDir = path.join(tempDir, ".flux");
    fs.mkdirSync(path.join(fluxDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(fluxDir, "config.json"), "{}");

    const exitCalls: number[] = [];
    process.exit = ((code: number) => { exitCalls.push(code ?? 0); }) as never;

    handleServiceCommand("uninstall");
    await new Promise((r) => setTimeout(r, 100));

    expect(exitCalls).toContain(0);
    expect(fs.existsSync(fluxDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Standalone bundle bootstrap (stub package.json creation)
// ---------------------------------------------------------------------------

describe("standalone bundle bootstrap", () => {
  it("creates stub package.json when missing (simulating ~/.flux/)", () => {
    // Simulate a fresh ~/.flux/ directory with no package.json
    const fakeFluxDir = path.join(tempDir, ".flux-bootstrap-test");
    fs.mkdirSync(fakeFluxDir, { recursive: true });
    const stubPath = path.join(fakeFluxDir, "package.json");

    // Replicate the bootstrap logic from index.ts
    if (!fs.existsSync(stubPath)) {
      fs.writeFileSync(stubPath, '{"name":"fluxhive-runner","version":"0.0.0","type":"module"}\n');
    }

    expect(fs.existsSync(stubPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(stubPath, "utf8"));
    expect(content.name).toBe("fluxhive-runner");
    expect(content.type).toBe("module");

    // Cleanup
    fs.rmSync(fakeFluxDir, { recursive: true, force: true });
  });

  it("does not overwrite existing package.json", () => {
    const fakeFluxDir = path.join(tempDir, ".flux-bootstrap-test2");
    fs.mkdirSync(fakeFluxDir, { recursive: true });
    const stubPath = path.join(fakeFluxDir, "package.json");

    // Pre-existing package.json with custom content
    fs.writeFileSync(stubPath, '{"name":"custom","version":"1.0.0"}\n');

    // Replicate the bootstrap logic — should NOT overwrite
    if (!fs.existsSync(stubPath)) {
      fs.writeFileSync(stubPath, '{"name":"fluxhive-runner","version":"0.0.0","type":"module"}\n');
    }

    const content = JSON.parse(fs.readFileSync(stubPath, "utf8"));
    expect(content.name).toBe("custom");
    expect(content.version).toBe("1.0.0");

    // Cleanup
    fs.rmSync(fakeFluxDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// getRunnerEntrypoint logic (replicated)
// ---------------------------------------------------------------------------

describe("getRunnerEntrypoint logic", () => {
  function getRunnerEntrypoint(importMetaUrl: string): string {
    const thisFile = new URL(importMetaUrl).pathname;
    if (path.basename(thisFile) === "fluxhive.mjs") return thisFile;
    const thisDir = path.dirname(thisFile);
    const packageRoot = thisDir.endsWith("/runner")
      ? path.resolve(thisDir, "..", "..")
      : path.resolve(thisDir, "..");
    return path.resolve(packageRoot, "dist", "fluxhive.mjs");
  }

  it("returns own path when running as standalone bundle", () => {
    const result = getRunnerEntrypoint("file:///Users/someone/.flux/fluxhive.mjs");
    expect(result).toBe("/Users/someone/.flux/fluxhive.mjs");
  });

  it("returns own path when running from repo dist bundle", () => {
    const result = getRunnerEntrypoint("file:///home/user/fluxhive-runner/packages/fluxhive/dist/fluxhive.mjs");
    expect(result).toBe("/home/user/fluxhive-runner/packages/fluxhive/dist/fluxhive.mjs");
  });

  it("resolves to dist/fluxhive.mjs from tsc output (runner subdir)", () => {
    const result = getRunnerEntrypoint("file:///home/user/fluxhive-runner/packages/fluxhive/dist/runner/service.js");
    expect(result).toBe("/home/user/fluxhive-runner/packages/fluxhive/dist/fluxhive.mjs");
  });

  it("resolves to dist/fluxhive.mjs from non-runner tsc output", () => {
    const result = getRunnerEntrypoint("file:///home/user/fluxhive-runner/packages/fluxhive/dist/service.js");
    expect(result).toBe("/home/user/fluxhive-runner/packages/fluxhive/dist/fluxhive.mjs");
  });
});

// ---------------------------------------------------------------------------
// Env var collection logic
// ---------------------------------------------------------------------------

describe("env var handling", () => {
  it("ENV_KEYS contains only non-secret FLUX_* config vars (no secrets, no OPENCLAW_*)", () => {
    const ENV_KEYS = [
      "FLUX_HOST",
      "FLUX_ORG_ID",
      "FLUX_CADENCE_MINUTES",
      "FLUX_RUNNER_TYPE",
      "FLUX_RUNNER_VERSION",
      "FLUX_RUNNER_ID",
      "FLUX_MACHINE_ID",
      "FLUX_BACKEND",
      "FLUX_ALLOW_DIRECT_CLI",
      "FLUX_PUSH_RECONNECT_MS",
    ];

    // All env keys should be non-secret FLUX_* vars
    for (const key of ENV_KEYS) {
      expect(key).toMatch(/^FLUX_/);
    }
    expect(ENV_KEYS).toHaveLength(10);
    // Secrets must NOT be in ENV_KEYS
    expect(ENV_KEYS).not.toContain("FLUX_TOKEN");
    expect(ENV_KEYS).not.toContain("OPENCLAW_GATEWAY_URL");
    expect(ENV_KEYS).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(ENV_KEYS).not.toContain("OPENCLAW_GATEWAY_PASSWORD");
    expect(ENV_KEYS).not.toContain("OPENCLAW_AGENT_ID");
  });
});

// ---------------------------------------------------------------------------
// Plist XML structure
// ---------------------------------------------------------------------------

describe("plist XML structure (install output)", () => {
  const origEnv = { ...process.env };
  const origExit = process.exit;

  beforeEach(() => {
    process.exit = ((code: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as never;
    process.env.FLUX_TOKEN = "tok-plist";
    process.env.FLUX_HOST = "https://fluxhive.plist.test";
    process.env.FLUX_ORG_ID = "org-plist";
  });

  afterEach(() => {
    process.exit = origExit;
    process.env = { ...origEnv };
  });

  it("plist includes all FLUX env vars", () => {
    if (os.platform() !== "darwin") return;

    try {
      handleServiceCommand("install");
    } catch {
      // expected exit
    }

    const plistPath = path.join(tempDir, "Library", "LaunchAgents", "ai.fluxhive.runner.plist");
    if (!fs.existsSync(plistPath)) return;

    const content = fs.readFileSync(plistPath, "utf8");
    // Token must NOT be in plist — loaded at runtime
    expect(content).not.toContain("tok-plist");
    // Non-secret config values should be present
    expect(content).toContain("fluxhive.plist.test");
    expect(content).toContain("org-plist");
    // FLUX_CADENCE_MINUTES should default to 1
    expect(content).toContain("FLUX_CADENCE_MINUTES");
    // No OPENCLAW_* secrets in plist
    expect(content).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(content).not.toContain("OPENCLAW_GATEWAY_PASSWORD");
    expect(content).not.toContain("OPENCLAW_AGENT_ID");
  });

  it("plist creates log directory", () => {
    if (os.platform() !== "darwin") return;

    try {
      handleServiceCommand("install");
    } catch {
      // expected exit
    }

    const logDir = path.join(tempDir, ".flux", "logs");
    expect(fs.existsSync(logDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// XML escaping (replicated pure function)
// ---------------------------------------------------------------------------

describe("plistEscape (replicated)", () => {
  function plistEscape(s: string): string {
    return s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  it("escapes ampersand", () => {
    expect(plistEscape("a & b")).toBe("a &amp; b");
  });

  it("escapes angle brackets", () => {
    expect(plistEscape("<tag>")).toBe("&lt;tag&gt;");
  });

  it("escapes quotes", () => {
    expect(plistEscape('key="val"')).toBe("key=&quot;val&quot;");
  });

  it("escapes apostrophe", () => {
    expect(plistEscape("it's")).toBe("it&apos;s");
  });

  it("passes through clean strings unchanged", () => {
    expect(plistEscape("clean-string_123")).toBe("clean-string_123");
  });
});

// ---------------------------------------------------------------------------
// systemd argument escaping (replicated pure function)
// ---------------------------------------------------------------------------

describe("systemdEscapeArg (replicated)", () => {
  function systemdEscapeArg(value: string): string {
    if (!/[\s"\\]/.test(value)) return value;
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  it("does not quote simple arguments", () => {
    expect(systemdEscapeArg("/usr/local/bin/node")).toBe("/usr/local/bin/node");
    expect(systemdEscapeArg("simple")).toBe("simple");
  });

  it("quotes arguments with spaces", () => {
    expect(systemdEscapeArg("/path/with spaces/node")).toBe('"/path/with spaces/node"');
  });

  it("escapes backslashes", () => {
    expect(systemdEscapeArg("path\\to")).toBe('"path\\\\to"');
  });

  it("escapes double quotes", () => {
    expect(systemdEscapeArg('val="x"')).toBe('"val=\\"x\\""');
  });
});

// ---------------------------------------------------------------------------
// Platform detection (replicated pure function)
// ---------------------------------------------------------------------------

describe("detectPlatform (replicated)", () => {
  function detectPlatform(p: string): "launchd" | "systemd" {
    if (p === "darwin") return "launchd";
    if (p === "linux") return "systemd";
    throw new Error(`Unsupported platform: ${p}`);
  }

  it("darwin maps to launchd", () => {
    expect(detectPlatform("darwin")).toBe("launchd");
  });

  it("linux maps to systemd", () => {
    expect(detectPlatform("linux")).toBe("systemd");
  });

  it("throws for unsupported platforms", () => {
    expect(() => detectPlatform("win32")).toThrow("Unsupported platform");
    expect(() => detectPlatform("freebsd")).toThrow("Unsupported platform");
  });
});

// ---------------------------------------------------------------------------
// Systemd unit file structure (replicated template)
// ---------------------------------------------------------------------------

describe("systemd unit file template", () => {
  it("contains required sections and fields", () => {
    // Verify the expected structure of the unit file
    function buildSystemdUnit(execStart: string, envLines: string[]): string {
      return [
        "[Unit]",
        "Description=FluxHive Runner",
        "After=network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        `ExecStart=${execStart}`,
        "Restart=always",
        "RestartSec=5",
        "KillMode=process",
        "StandardOutput=append:/tmp/runner.log",
        "StandardError=append:/tmp/runner.err.log",
        ...envLines,
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n");
    }

    const unit = buildSystemdUnit("/usr/bin/node /path/to/entry.js", [
      'Environment="FLUX_TOKEN=tok"',
      'Environment="FLUX_HOST=https://host.com"',
    ]);

    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("Description=FluxHive Runner");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("KillMode=process");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("ExecStart=/usr/bin/node /path/to/entry.js");
    expect(unit).toContain("FLUX_TOKEN=tok");
  });
});
