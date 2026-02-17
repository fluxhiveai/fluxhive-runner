import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IntegrationConfig } from "./core/types.js";

const DEFAULT_CONFIG_NAME = "project.config.json";

/**
 * Load IntegrationConfig from a JSON file.
 * Returns null if no file found (config is optional).
 * Only needed for GitHub integration users.
 */
export async function loadIntegrationConfig(
  configPath?: string,
): Promise<IntegrationConfig | null> {
  const filePath = configPath ?? resolve(process.cwd(), DEFAULT_CONFIG_NAME);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    // If an explicit path was provided and it's missing, that's an error
    if (configPath) {
      throw new Error(`Integration config not found at ${filePath}`);
    }
    // Otherwise, config is simply not present — that's fine
    return null;
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;

  if (!parsed.owner || typeof parsed.owner !== "string") {
    throw new Error("Integration config missing required field: owner");
  }
  if (!parsed.repo || typeof parsed.repo !== "string") {
    throw new Error("Integration config missing required field: repo");
  }

  return {
    owner: parsed.owner,
    repo: parsed.repo,
    projectId: parsed.projectId as string | undefined,
    projectNumber: parsed.projectNumber as number | undefined,
    pollIntervalSeconds: (parsed.pollIntervalSeconds as number) ?? 60,
    stages: parsed.stages as IntegrationConfig["stages"],
    fields: parsed.fields as IntegrationConfig["fields"],
  };
}
