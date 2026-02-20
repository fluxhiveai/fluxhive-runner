import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// Mock homedir so config file operations use a temp directory
// ---------------------------------------------------------------------------

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fluxhive-cli-config-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:os");
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => tempDir,
    },
    homedir: () => tempDir,
  };
});

// Import after mocks are set up
const { resolveConfig, writeConfigFile, getConfigFilePath, getConfigDir } =
  await import("../src/config.ts");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getConfigFilePath", () => {
  it("returns path under ~/.flux/", () => {
    const configPath = getConfigFilePath();
    expect(configPath).toBe(path.join(tempDir, ".flux", "config.json"));
  });
});

describe("getConfigDir", () => {
  it("returns ~/.flux/ directory", () => {
    expect(getConfigDir()).toBe(path.join(tempDir, ".flux"));
  });
});

describe("writeConfigFile", () => {
  it("creates config directory and writes JSON", () => {
    writeConfigFile({
      host: "https://example.com",
      token: "tok-123",
      orgId: "org-1",
    });

    const configPath = getConfigFilePath();
    expect(fs.existsSync(configPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(content.host).toBe("https://example.com");
    expect(content.token).toBe("tok-123");
    expect(content.orgId).toBe("org-1");
  });

  it("sets restrictive file permissions (0o600)", () => {
    writeConfigFile({ host: "https://h.com", token: "t" });

    const stat = fs.statSync(getConfigFilePath());
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("sets restrictive directory permissions (0o700)", () => {
    writeConfigFile({ host: "https://h.com", token: "t" });

    const stat = fs.statSync(getConfigDir());
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe("resolveConfig", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.FLUX_HOST;
    delete process.env.FLUX_TOKEN;
    delete process.env.FLUX_ORG_ID;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("resolves from CLI flags", () => {
    const config = resolveConfig({
      host: "https://cli-host.com",
      token: "cli-token",
    });
    expect(config.host).toBe("https://cli-host.com");
    expect(config.token).toBe("cli-token");
    expect(config.mcpBase).toBe("https://cli-host.com/mcp/v1");
  });

  it("resolves from env vars", () => {
    process.env.FLUX_HOST = "https://env-host.com";
    process.env.FLUX_TOKEN = "env-token";
    process.env.FLUX_ORG_ID = "org-env";

    const config = resolveConfig({});
    expect(config.host).toBe("https://env-host.com");
    expect(config.token).toBe("env-token");
    expect(config.orgId).toBe("org-env");
  });

  it("resolves from config file", () => {
    writeConfigFile({
      host: "https://file-host.com",
      token: "file-token",
      orgId: "org-file",
    });

    const config = resolveConfig({});
    expect(config.host).toBe("https://file-host.com");
    expect(config.token).toBe("file-token");
    expect(config.orgId).toBe("org-file");
  });

  it("CLI flags override env vars", () => {
    process.env.FLUX_HOST = "https://env-host.com";
    process.env.FLUX_TOKEN = "env-token";

    const config = resolveConfig({
      host: "https://cli-host.com",
      token: "cli-token",
    });
    expect(config.host).toBe("https://cli-host.com");
    expect(config.token).toBe("cli-token");
  });

  it("env vars override config file", () => {
    writeConfigFile({
      host: "https://file-host.com",
      token: "file-token",
    });
    process.env.FLUX_HOST = "https://env-host.com";
    process.env.FLUX_TOKEN = "env-token";

    const config = resolveConfig({});
    expect(config.host).toBe("https://env-host.com");
    expect(config.token).toBe("env-token");
  });

  it("strips trailing slashes from host", () => {
    const config = resolveConfig({
      host: "https://example.com///",
      token: "tok",
    });
    expect(config.host).toBe("https://example.com");
    expect(config.mcpBase).toBe("https://example.com/mcp/v1");
  });

  it("throws when no host is configured", () => {
    // Ensure config file doesn't have host
    const configPath = getConfigFilePath();
    if (fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, JSON.stringify({ token: "tok" }));
    }

    expect(() => resolveConfig({})).toThrow("No Flux host configured");
  });

  it("throws when no token is configured", () => {
    process.env.FLUX_HOST = "https://host.com";

    // Ensure config file doesn't have token
    const configPath = getConfigFilePath();
    if (fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, JSON.stringify({ host: "https://host.com" }));
    }

    expect(() => resolveConfig({})).toThrow("No Flux token configured");
  });
});
