/* eslint-disable no-console */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runnerDir = path.resolve(__dirname, "../../../packages/runner");
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function parseDotEnv(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

function applyLegacyEnvMapping() {
  // Keep `apps/runner/.env` as the single local dev entrypoint.
  // Map legacy MCP_* variables onto the newer @flux/runner FLUX_* config.
  const envPath = path.resolve(__dirname, "../.env");
  try {
    const raw = readFileSync(envPath, "utf8");
    const map = parseDotEnv(raw);
    // Populate env from apps/runner/.env without overwriting already-exported vars.
    // This keeps local dev ergonomic (OPENCLAW_GATEWAY_URL, etc.) when invoking from apps/runner.
    for (const [key, value] of Object.entries(map)) {
      if (!key) continue;
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    if (!process.env.FLUX_TOKEN && map.MCP_TOKEN) {
      process.env.FLUX_TOKEN = map.MCP_TOKEN;
    }
    // Prefer apps/runner/.env over the repo root env to avoid port mismatches (3211 vs 3210).
    const convexUrl = map.CONVEX_URL || process.env.CONVEX_URL;
    if (!process.env.FLUX_HOST && convexUrl) {
      process.env.FLUX_HOST = convexUrl;
    }
    // FLUX_ORG_ID intentionally optional; runner can bootstrap via token at /SKILL.md.
  } catch {
    // ignore missing apps/runner/.env
  }
}

function runPnpm(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpmCmd, args, {
      cwd: runnerDir,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`pnpm ${args.join(" ")} failed with exit ${String(code)}`));
    });
  });
}

async function main() {
  applyLegacyEnvMapping();
  console.log("[mcp-runner] delegating to @flux/runner package");
  await runPnpm(["bundle"]);
  await runPnpm(["start"]);
}

main().catch((error) => {
  console.error("[mcp-runner] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
