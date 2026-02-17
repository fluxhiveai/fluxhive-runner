import { beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn<(path: string, encoding: string) => Promise<string>>();
vi.mock("node:fs/promises", () => ({
  readFile: (...args: [string, string]) => readFileMock(...args),
}));

import { loadIntegrationConfig } from "./config.js";

describe("loadIntegrationConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads valid config with all fields", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        owner: "openclaw",
        repo: "openclaw",
        projectId: "PVT_abc123",
        projectNumber: 7,
        pollIntervalSeconds: 30,
        stages: { triage: { agent: null } },
        fields: { priority: { fieldId: "F1", options: { high: "H" } } },
      }),
    );

    const config = await loadIntegrationConfig("/tmp/project.config.json");

    expect(config).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      projectId: "PVT_abc123",
      projectNumber: 7,
      pollIntervalSeconds: 30,
      stages: { triage: { agent: null } },
      fields: { priority: { fieldId: "F1", options: { high: "H" } } },
    });
    expect(readFileMock).toHaveBeenCalledWith("/tmp/project.config.json", "utf-8");
  });

  it("uses default pollIntervalSeconds (60) when not specified", async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({ owner: "acme", repo: "widget" }));

    const config = await loadIntegrationConfig("/tmp/config.json");

    expect(config).not.toBeNull();
    expect(config!.pollIntervalSeconds).toBe(60);
  });

  it("returns null when no explicit path and file not found", async () => {
    readFileMock.mockRejectedValueOnce(new Error("ENOENT"));

    const config = await loadIntegrationConfig();

    expect(config).toBeNull();
  });

  it("throws when explicit path provided and file not found", async () => {
    readFileMock.mockRejectedValueOnce(new Error("ENOENT"));

    await expect(loadIntegrationConfig("/no/such/path.json")).rejects.toThrow(
      "Integration config not found at /no/such/path.json",
    );
  });

  it("throws when owner missing", async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({ repo: "widget" }));

    await expect(loadIntegrationConfig("/tmp/config.json")).rejects.toThrow(
      "Integration config missing required field: owner",
    );
  });

  it("throws when repo missing", async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({ owner: "acme" }));

    await expect(loadIntegrationConfig("/tmp/config.json")).rejects.toThrow(
      "Integration config missing required field: repo",
    );
  });

  it("handles optional fields as undefined when absent", async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({ owner: "acme", repo: "widget" }));

    const config = await loadIntegrationConfig("/tmp/config.json");

    expect(config).not.toBeNull();
    expect(config!.projectId).toBeUndefined();
    expect(config!.projectNumber).toBeUndefined();
    expect(config!.stages).toBeUndefined();
    expect(config!.fields).toBeUndefined();
  });
});
