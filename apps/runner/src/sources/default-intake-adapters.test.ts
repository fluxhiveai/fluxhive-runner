import { describe, expect, it, vi } from "vitest";

vi.mock("./github-intake-adapter.js", () => ({
  createGitHubIntakeAdapter: () => ({
    type: "github",
    pollIntegration: vi.fn(),
  }),
}));

describe("default-intake-adapters", () => {
  it("includes built-in GitHub adapter", async () => {
    const { createDefaultIntegrationIntakeAdapters } = await import("./default-intake-adapters.js");
    const adapters = createDefaultIntegrationIntakeAdapters();
    expect(adapters.map((adapter) => adapter.type)).toEqual(["github"]);
  });
});
