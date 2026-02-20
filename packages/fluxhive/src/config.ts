/**
 * Configuration loader for the FluxHive CLI.
 *
 * Precedence: CLI flags > env vars > ~/.flux/config.json > error.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

export type FluxConfig = {
  host: string;
  token: string;
  orgId?: string;
  mcpBase: string;
};

export type ConfigFileData = {
  host?: string;
  token?: string;
  orgId?: string;
};

const CONFIG_DIR = path.join(os.homedir(), ".flux");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

/** Read the config file, returning null if it doesn't exist. */
function readConfigFile(): ConfigFileData | null {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as ConfigFileData;
  } catch {
    return null;
  }
}

/** Write credentials to ~/.flux/config.json, creating the directory if needed. */
export function writeConfigFile(data: ConfigFileData): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** Get the config file path. */
export function getConfigFilePath(): string {
  return CONFIG_FILE;
}

/** Get the config directory path. */
export function getConfigDir(): string {
  return CONFIG_DIR;
}

/** Strip trailing slashes from a URL. */
function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Resolve configuration from CLI opts, env vars, and config file.
 * CLI flags take highest priority, then env vars, then config file.
 */
export function resolveConfig(opts: {
  host?: string;
  token?: string;
}): FluxConfig {
  const file = readConfigFile();

  const host = opts.host || process.env.FLUX_HOST || file?.host;
  const token = opts.token || process.env.FLUX_TOKEN || file?.token;
  const orgId = process.env.FLUX_ORG_ID || file?.orgId;

  if (!host) {
    throw new Error(
      "No Flux host configured. Set FLUX_HOST, use --host, or run 'fluxhive access redeem'.",
    );
  }
  if (!token) {
    throw new Error(
      "No Flux token configured. Set FLUX_TOKEN, use --token, or run 'fluxhive access redeem'.",
    );
  }

  const normalizedHost = normalizeUrl(host);
  const mcpBase = `${normalizedHost}/mcp/v1`;

  return { host: normalizedHost, token, orgId, mcpBase };
}
