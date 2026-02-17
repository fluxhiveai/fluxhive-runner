import type { IntegrationIntakeAdapter } from "./integration-adapter.js";
import { createGitHubIntakeAdapter } from "./github-intake-adapter.js";

export function createDefaultIntegrationIntakeAdapters(): IntegrationIntakeAdapter[] {
  return [createGitHubIntakeAdapter()];
}
