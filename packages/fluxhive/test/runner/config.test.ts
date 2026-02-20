import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// We cannot import the internal helpers directly because they are not exported.
// Instead we test them through loadRunnerConfig which uses all of them, plus
// we re-implement the pure functions locally to test their logic directly.
// For loadRunnerConfig, we mock fetch to serve SKILL.md content.

// ---------------------------------------------------------------------------
// Import the module under test (loadRunnerConfig is the only export)
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// We need to import after stubbing fetch
const { loadRunnerConfig } = await import("../../src/runner/config.ts");

// ---------------------------------------------------------------------------
// Re-implement pure internal helpers for direct testing
// (They are not exported, so we replicate them here to verify logic.)
// ---------------------------------------------------------------------------

// Replicate normalizeHttpBase
function normalizeHttpBase(base: string): string {
  return base.replace(/\/+$/, "");
}

// Replicate parseNumberEnv
function parseNumberEnv(name: string, fallback: number, env: Record<string, string | undefined>): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Replicate extractFrontmatter
function extractFrontmatter(markdown: string) {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith("---")) {
    throw new Error("SKILL.md missing YAML frontmatter");
  }
  const match = trimmed.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match?.[1]) {
    throw new Error("SKILL.md frontmatter parse failed");
  }
  // We do a simplified YAML parse here
  const lines = match[1].split("\n");
  const parsed: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      let val = line.slice(colon + 1).trim();
      // Remove surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      parsed[key] = val;
    }
  }
  if (!parsed.protocolVersion) throw new Error("SKILL.md missing protocolVersion");
  if (!parsed.orgId) throw new Error("SKILL.md missing orgId");
  return parsed;
}

// Replicate resolveMcpBase
function resolveMcpBase(fluxHost: string, mcpHttpBase: string | undefined): string {
  const fallback = `${normalizeHttpBase(fluxHost)}/mcp/v1`;
  const raw = mcpHttpBase?.trim();
  if (!raw || raw.length === 0) return fallback;
  if (raw.includes("YOUR_HOST")) return fallback;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return normalizeHttpBase(raw);
  if (raw.startsWith("/")) return `${normalizeHttpBase(fluxHost)}${raw}`;
  return fallback;
}

// ---------------------------------------------------------------------------
// Helper to build SKILL.md content
// ---------------------------------------------------------------------------

function buildSkillMd(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    protocolVersion: "1",
    orgId: "org-test-123",
    product: "FluxHive",
    updatedAt: "2024-01-01",
    mcpHttpBase: "https://api.example.com/mcp/v1",
    ...overrides,
  };
  const frontmatter = Object.entries(fields)
    .map(([k, v]) => `${k}: "${v}"`)
    .join("\n");
  return `---\n${frontmatter}\n---\n\n# Skill Manifest\nThis is a test skill.`;
}

function mockFetchSkillMd(skillMd: string, status = 200) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: async () => skillMd,
  });
}

// ---------------------------------------------------------------------------
// Tests for pure internal logic (replicated)
// ---------------------------------------------------------------------------

describe("normalizeHttpBase", () => {
  it("strips trailing slashes", () => {
    expect(normalizeHttpBase("https://example.com///")).toBe("https://example.com");
  });

  it("leaves clean URLs unchanged", () => {
    expect(normalizeHttpBase("https://example.com")).toBe("https://example.com");
  });
});

describe("parseNumberEnv", () => {
  it("returns fallback for missing var", () => {
    expect(parseNumberEnv("MISSING", 42, {})).toBe(42);
  });

  it("returns fallback for non-numeric value", () => {
    expect(parseNumberEnv("BAD", 10, { BAD: "not-a-number" })).toBe(10);
  });

  it("parses valid number", () => {
    expect(parseNumberEnv("GOOD", 10, { GOOD: "25" })).toBe(25);
  });

  it("returns fallback for empty string", () => {
    expect(parseNumberEnv("EMPTY", 5, { EMPTY: "  " })).toBe(5);
  });

  it("returns fallback for Infinity", () => {
    expect(parseNumberEnv("INF", 5, { INF: "Infinity" })).toBe(5);
  });
});

describe("extractFrontmatter (replicated)", () => {
  it("parses YAML from markdown", () => {
    const md = buildSkillMd();
    const fm = extractFrontmatter(md);
    expect(fm.protocolVersion).toBe("1");
    expect(fm.orgId).toBe("org-test-123");
  });

  it("throws on missing frontmatter delimiters", () => {
    expect(() => extractFrontmatter("# Just a heading")).toThrow("SKILL.md missing YAML frontmatter");
  });

  it("throws on missing protocolVersion", () => {
    const md = "---\norgId: org-1\n---\n";
    expect(() => extractFrontmatter(md)).toThrow("SKILL.md missing protocolVersion");
  });

  it("throws on missing orgId", () => {
    const md = "---\nprotocolVersion: 1\n---\n";
    expect(() => extractFrontmatter(md)).toThrow("SKILL.md missing orgId");
  });
});

describe("resolveMcpBase (replicated)", () => {
  it("returns fallback when mcpHttpBase is empty", () => {
    expect(resolveMcpBase("https://host.com", "")).toBe("https://host.com/mcp/v1");
    expect(resolveMcpBase("https://host.com", undefined)).toBe("https://host.com/mcp/v1");
  });

  it("returns fallback when mcpHttpBase contains YOUR_HOST placeholder", () => {
    expect(resolveMcpBase("https://host.com", "https://YOUR_HOST/mcp/v1")).toBe(
      "https://host.com/mcp/v1",
    );
  });

  it("uses mcpHttpBase as-is when it starts with http(s)://", () => {
    expect(resolveMcpBase("https://host.com", "https://custom.api.com/mcp/v1/")).toBe(
      "https://custom.api.com/mcp/v1",
    );
  });

  it("prepends fluxHost when mcpHttpBase starts with /", () => {
    expect(resolveMcpBase("https://host.com/", "/api/mcp")).toBe("https://host.com/api/mcp");
  });

  it("returns fallback for non-URL non-path values", () => {
    expect(resolveMcpBase("https://host.com", "just-a-string")).toBe("https://host.com/mcp/v1");
  });
});

// ---------------------------------------------------------------------------
// Integration tests for loadRunnerConfig
// ---------------------------------------------------------------------------

describe("loadRunnerConfig", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    fetchMock.mockReset();
    // Set minimum required env vars
    process.env.FLUX_TOKEN = "tok-abc";
    process.env.FLUX_HOST = "https://fluxhive.test";
    // Clear optional ones that could interfere
    delete process.env.FLUX_ORG_ID;
    delete process.env.FLUX_RUNNER_TYPE;
    delete process.env.FLUX_RUNNER_VERSION;
    delete process.env.FLUX_RUNNER_ID;
    delete process.env.FLUX_MACHINE_ID;
    delete process.env.FLUX_CADENCE_MINUTES;
    delete process.env.FLUX_PUSH_RECONNECT_MS;
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_AGENT_ID;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("loads config successfully with valid SKILL.md", async () => {
    const skillMd = buildSkillMd();
    mockFetchSkillMd(skillMd);

    const config = await loadRunnerConfig();

    expect(config.fluxHost).toBe("https://fluxhive.test");
    expect(config.fluxToken).toBe("tok-abc");
    expect(config.fluxOrgId).toBe("org-test-123");
    expect(config.runnerType).toBe("fluxhive-openclaw-runner");
    expect(config.runnerVersion).toBe("0.1.0");
    expect(config.cadenceMinutes).toBeGreaterThanOrEqual(1);
  });

  it("throws on missing FLUX_TOKEN", async () => {
    delete process.env.FLUX_TOKEN;
    await expect(loadRunnerConfig()).rejects.toThrow("Missing required env var FLUX_TOKEN");
  });

  it("throws on missing FLUX_HOST", async () => {
    delete process.env.FLUX_HOST;
    await expect(loadRunnerConfig()).rejects.toThrow("Missing required env var FLUX_HOST");
  });

  it("throws on protocol version mismatch", async () => {
    const skillMd = buildSkillMd({ protocolVersion: "99" });
    mockFetchSkillMd(skillMd);

    await expect(loadRunnerConfig()).rejects.toThrow("Unsupported SKILL.md protocolVersion");
  });

  it("throws on org ID mismatch when FLUX_ORG_ID is set", async () => {
    process.env.FLUX_ORG_ID = "org-different";
    const skillMd = buildSkillMd({ orgId: "org-test-123" });
    mockFetchSkillMd(skillMd);

    await expect(loadRunnerConfig()).rejects.toThrow("SKILL.md orgId mismatch");
  });

  it("includes FLUX_ORG_ID in the SKILL.md fetch URL when set", async () => {
    process.env.FLUX_ORG_ID = "org-test-123";
    const skillMd = buildSkillMd({ orgId: "org-test-123" });
    mockFetchSkillMd(skillMd);

    await loadRunnerConfig();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/orgs/org-test-123/SKILL.md");
  });

  it("fetches SKILL.md without org path when FLUX_ORG_ID is not set", async () => {
    const skillMd = buildSkillMd();
    mockFetchSkillMd(skillMd);

    await loadRunnerConfig();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://fluxhive.test/SKILL.md");
    expect(url).not.toContain("/orgs/");
  });

  it("throws when SKILL.md fetch fails", async () => {
    mockFetchSkillMd("Not Found", 404);

    await expect(loadRunnerConfig()).rejects.toThrow("Failed to fetch SKILL.md");
  });

  it("passes token as authorization header when fetching SKILL.md", async () => {
    const skillMd = buildSkillMd();
    mockFetchSkillMd(skillMd);

    await loadRunnerConfig();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-abc");
  });

  it("resolves mcpBase from frontmatter", async () => {
    const skillMd = buildSkillMd({ mcpHttpBase: "https://custom.mcp.com/v1/" });
    mockFetchSkillMd(skillMd);

    const config = await loadRunnerConfig();
    expect(config.fluxMcpBase).toBe("https://custom.mcp.com/v1");
  });

  it("uses optional env vars for runner metadata", async () => {
    process.env.FLUX_RUNNER_TYPE = "custom-runner";
    process.env.FLUX_RUNNER_VERSION = "2.0.0";
    process.env.FLUX_MACHINE_ID = "my-machine";
    process.env.FLUX_CADENCE_MINUTES = "5";
    process.env.FLUX_PUSH_RECONNECT_MS = "10000";
    process.env.OPENCLAW_GATEWAY_URL = "ws://localhost:18789";
    process.env.OPENCLAW_GATEWAY_TOKEN = "gw-token";
    process.env.OPENCLAW_AGENT_ID = "agent-x";

    const skillMd = buildSkillMd();
    mockFetchSkillMd(skillMd);

    const config = await loadRunnerConfig();

    expect(config.runnerType).toBe("custom-runner");
    expect(config.runnerVersion).toBe("2.0.0");
    expect(config.machineId).toBe("my-machine");
    expect(config.cadenceMinutes).toBe(5);
    expect(config.pushReconnectMs).toBe(10000);
    expect(config.openclawGatewayUrl).toBe("ws://localhost:18789");
    expect(config.openclawGatewayToken).toBe("gw-token");
    expect(config.openclawAgentId).toBe("agent-x");
  });

  it("enforces minimum cadenceMinutes of 1", async () => {
    process.env.FLUX_CADENCE_MINUTES = "0";
    const skillMd = buildSkillMd();
    mockFetchSkillMd(skillMd);

    const config = await loadRunnerConfig();
    expect(config.cadenceMinutes).toBe(1);
  });

  it("enforces minimum pushReconnectMs of 250", async () => {
    process.env.FLUX_PUSH_RECONNECT_MS = "50";
    const skillMd = buildSkillMd();
    mockFetchSkillMd(skillMd);

    const config = await loadRunnerConfig();
    expect(config.pushReconnectMs).toBe(250);
  });
});
