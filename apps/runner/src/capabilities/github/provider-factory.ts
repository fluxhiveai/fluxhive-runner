import type { GitHubCapability } from "./types.js";
import { createOpenClawGitHubCapabilityProvider } from "./provider-openclaw.js";

export function createGitHubCapabilityProvider(
  _opts: {
    providerName?: "openclaw";
  } = {},
): GitHubCapability {
  return createOpenClawGitHubCapabilityProvider();
}
