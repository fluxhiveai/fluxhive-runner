import { describe, expect, it } from "vitest";
import { createGitHubCapabilityProvider } from "./provider-factory.js";

describe("github provider factory", () => {
  it("creates openclaw provider implementation by default", () => {
    const provider = createGitHubCapabilityProvider();
    expect(provider.providerName).toBe("openclaw");
  });

  it("creates openclaw provider implementation when explicitly requested", () => {
    const provider = createGitHubCapabilityProvider({ providerName: "openclaw" });
    expect(provider.providerName).toBe("openclaw");
  });
});
