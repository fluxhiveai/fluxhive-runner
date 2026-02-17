import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OpenClawConfig } from "./types.js";

function resolveConfigPath(): string {
  const envPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (envPath) {
    return resolve(envPath);
  }
  return resolve(process.cwd(), "openclaw.json");
}

export function loadConfig(): OpenClawConfig {
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as OpenClawConfig;
  return parsed ?? {};
}
