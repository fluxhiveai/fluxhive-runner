/**
 * Runner configuration loader.
 *
 * Reads environment variables and the org's SKILL.md manifest to produce a
 * fully resolved RunnerConfig. The SKILL.md is fetched from the Flux server
 * at startup and its YAML frontmatter supplies orgId, MCP base URL, and
 * protocol version.
 *
 * Config loading order:
 *   1. .env / .env.local (if present, for local dev ergonomics)
 *   2. Required env vars: FLUX_TOKEN, FLUX_HOST
 *   3. Optional env vars: FLUX_ORG_ID, FLUX_CADENCE_MINUTES, etc.
 *   4. SKILL.md fetch → frontmatter parse → orgId + MCP base resolution
 */
import process from "node:process";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import type { RunnerConfig, SkillManifestFrontmatter } from "../types.js";
import { VERSION } from "../version.js";

/** Reads a required environment variable or throws with a clear message. */
function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

/** Reads a numeric env var, falling back to `fallback` if absent or non-finite. */
function parseNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Strips trailing slashes from a URL base so paths can be appended cleanly. */
function normalizeHttpBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/**
 * Parses YAML frontmatter from a SKILL.md document.
 * The frontmatter is delimited by `---` fences and must contain at minimum
 * `protocolVersion` and `orgId` fields.
 */
function extractFrontmatter(markdown: string): SkillManifestFrontmatter {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith("---")) {
    throw new Error("SKILL.md missing YAML frontmatter");
  }
  const match = trimmed.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match?.[1]) {
    throw new Error("SKILL.md frontmatter parse failed");
  }
  const parsed = YAML.parse(match[1]) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("SKILL.md frontmatter is not a YAML object");
  }
  const protocolVersion =
    typeof parsed.protocolVersion === "string" ? parsed.protocolVersion : undefined;
  const orgId = typeof parsed.orgId === "string" ? parsed.orgId : undefined;
  if (!protocolVersion) {
    throw new Error("SKILL.md missing protocolVersion");
  }
  if (!orgId) {
    throw new Error("SKILL.md missing orgId");
  }
  return {
    protocolVersion,
    product: typeof parsed.product === "string" ? parsed.product : undefined,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    orgId,
    mcpHttpBase: typeof parsed.mcpHttpBase === "string" ? parsed.mcpHttpBase : undefined,
    mcpPushWs: typeof parsed.mcpPushWs === "string" ? parsed.mcpPushWs : undefined,
    joinRequestUrl: typeof parsed.joinRequestUrl === "string" ? parsed.joinRequestUrl : undefined,
  };
}

/**
 * Resolves the MCP API base URL from the SKILL.md frontmatter's `mcpHttpBase`
 * field, falling back to `{fluxHost}/mcp/v1` if not specified or if it
 * contains a placeholder like YOUR_HOST.
 */
function resolveMcpBase(fluxHost: string, fm: SkillManifestFrontmatter): string {
  const fallback = `${normalizeHttpBase(fluxHost)}/mcp/v1`;
  const raw = fm.mcpHttpBase?.trim();
  if (!raw || raw.length === 0) {
    return fallback;
  }
  if (raw.includes("YOUR_HOST")) {
    return fallback;
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return normalizeHttpBase(raw);
  }
  if (raw.startsWith("/")) {
    return `${normalizeHttpBase(fluxHost)}${raw}`;
  }
  return fallback;
}

/**
 * Fetches the SKILL.md document from the Flux server.
 * When orgId is provided, fetches `/orgs/{orgId}/SKILL.md` (public).
 * When orgId is null, fetches `/SKILL.md` with Bearer auth (the server
 * derives the org from the token).
 */
async function fetchSkillManifest(
  fluxHost: string,
  orgId: string | null,
  token?: string,
): Promise<{ url: string; body: string; frontmatter: SkillManifestFrontmatter }> {
  const base = normalizeHttpBase(fluxHost);
  const url = orgId
    ? `${base}/orgs/${encodeURIComponent(orgId)}/SKILL.md`
    : `${base}/SKILL.md`;
  const res = await fetch(url, {
    method: "GET",
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Failed to fetch SKILL.md (${res.status}): ${body.slice(0, 500)}`);
  }
  const frontmatter = extractFrontmatter(body);
  return { url, body, frontmatter };
}

/**
 * Builds the complete runner configuration.
 * Loads .env files for local dev, reads all FLUX_* and OPENCLAW_* env vars,
 * fetches the SKILL.md, validates protocol version and orgId match, then
 * returns a fully resolved RunnerConfig ready for the main loop.
 */
export async function loadRunnerConfig(): Promise<RunnerConfig> {
  // Keep local dev ergonomic without overwriting already-exported vars.
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(".env");
      process.loadEnvFile(".env.local");
    } catch {
      // Ignore local env loading errors; required vars are validated below.
    }
  }

  const fluxToken = requiredEnv("FLUX_TOKEN");
  const fluxHost = requiredEnv("FLUX_HOST");
  const fluxOrgId = process.env.FLUX_ORG_ID?.trim() || null;
  const runnerType = process.env.FLUX_RUNNER_TYPE?.trim() || "fluxhive-openclaw-runner";
  const runnerVersion = process.env.FLUX_RUNNER_VERSION?.trim() || VERSION;
  const runnerInstanceId = process.env.FLUX_RUNNER_ID?.trim() || randomUUID();
  const machineId = process.env.FLUX_MACHINE_ID?.trim() || process.env.HOSTNAME || "unknown";
  const cadenceMinutes = Math.max(1, parseNumberEnv("FLUX_CADENCE_MINUTES", 15));
  const pushReconnectMs = Math.max(250, parseNumberEnv("FLUX_PUSH_RECONNECT_MS", 5000));
  const openclawGatewayUrl = process.env.OPENCLAW_GATEWAY_URL?.trim() || "";
  const openclawGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  const openclawGatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim();
  const openclawAgentId = process.env.OPENCLAW_AGENT_ID?.trim();

  const skill = await fetchSkillManifest(fluxHost, fluxOrgId, fluxToken);
  if (skill.frontmatter.protocolVersion !== "1") {
    throw new Error(
      `Unsupported SKILL.md protocolVersion=${JSON.stringify(skill.frontmatter.protocolVersion)}`,
    );
  }
  if (fluxOrgId && skill.frontmatter.orgId !== fluxOrgId) {
    throw new Error(
      `SKILL.md orgId mismatch (expected ${fluxOrgId}, got ${skill.frontmatter.orgId})`,
    );
  }

  return {
    fluxHost: normalizeHttpBase(fluxHost),
    fluxToken,
    fluxOrgId: skill.frontmatter.orgId,
    fluxMcpBase: resolveMcpBase(fluxHost, skill.frontmatter),
    skillManifestUrl: skill.url,
    skillManifestBody: skill.body,
    skillManifestFrontmatter: skill.frontmatter,
    runnerType,
    runnerVersion,
    runnerInstanceId,
    machineId,
    cadenceMinutes,
    pushReconnectMs,
    openclawGatewayUrl: openclawGatewayUrl || undefined,
    openclawGatewayToken: openclawGatewayToken || undefined,
    openclawGatewayPassword: openclawGatewayPassword || undefined,
    openclawAgentId: openclawAgentId || undefined,
  };
}
