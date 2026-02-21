import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareSemver,
  fetchLatestRelease,
  verifyChecksum,
} from "../../src/commands/update.js";

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------
describe("compareSemver", () => {
  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("returns -1 when a < b", () => {
    expect(compareSemver("0.7.2", "0.8.0")).toBe(-1);
    expect(compareSemver("0.7.2", "0.7.3")).toBe(-1);
    expect(compareSemver("0.7.2", "1.0.0")).toBe(-1);
  });

  it("returns 1 when a > b", () => {
    expect(compareSemver("0.8.0", "0.7.2")).toBe(1);
    expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
  });

  it("handles different segment counts", () => {
    expect(compareSemver("1.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0", "1.0.1")).toBe(-1);
    expect(compareSemver("1.0.1", "1.0")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// fetchLatestRelease
// ---------------------------------------------------------------------------
describe("fetchLatestRelease", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses a GitHub release response", async () => {
    const mockResponse = {
      tag_name: "v1.2.3",
      assets: [
        {
          name: "fluxhive.mjs",
          browser_download_url:
            "https://github.com/fluxhiveai/fluxhive-runner/releases/download/v1.2.3/fluxhive.mjs",
        },
        {
          name: "fluxhive.mjs.sha256",
          browser_download_url:
            "https://github.com/fluxhiveai/fluxhive-runner/releases/download/v1.2.3/fluxhive.mjs.sha256",
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }) as any;

    const result = await fetchLatestRelease();
    expect(result.version).toBe("1.2.3");
    expect(result.assets).toHaveLength(2);
    expect(result.assets[0].name).toBe("fluxhive.mjs");
    expect(result.assets[0].url).toContain("fluxhive.mjs");
  });

  it("strips v prefix from tag_name", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ tag_name: "v0.8.0", assets: [] }),
    }) as any;

    const result = await fetchLatestRelease();
    expect(result.version).toBe("0.8.0");
  });

  it("throws on non-OK response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not Found"),
    }) as any;

    await expect(fetchLatestRelease()).rejects.toThrow("GitHub API returned 404");
  });
});

// ---------------------------------------------------------------------------
// verifyChecksum
// ---------------------------------------------------------------------------
describe("verifyChecksum", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fluxhive-test-"));
    tmpFile = join(tmpDir, "test-file");
  });

  afterEach(() => {
    try {
      unlinkSync(tmpFile);
    } catch {}
  });

  it("returns true for matching checksum", async () => {
    const content = "hello fluxhive";
    writeFileSync(tmpFile, content);
    const expected = createHash("sha256").update(content).digest("hex");
    expect(await verifyChecksum(tmpFile, expected)).toBe(true);
  });

  it("returns false for mismatched checksum", async () => {
    writeFileSync(tmpFile, "hello fluxhive");
    expect(await verifyChecksum(tmpFile, "deadbeef".repeat(8))).toBe(false);
  });

  it("handles checksum with trailing whitespace", async () => {
    const content = "test content";
    writeFileSync(tmpFile, content);
    const expected = createHash("sha256").update(content).digest("hex");
    expect(await verifyChecksum(tmpFile, expected + "  \n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Update flow (integration-style)
// ---------------------------------------------------------------------------
describe("update command", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers as a commander command", async () => {
    const { Command } = await import("commander");
    const { registerUpdateCommand } = await import(
      "../../src/commands/update.js"
    );
    const program = new Command();
    registerUpdateCommand(program);
    const updateCmd = program.commands.find((c) => c.name() === "update");
    expect(updateCmd).toBeDefined();
    expect(updateCmd!.description()).toBe(
      "Update fluxhive to the latest version",
    );
  });
});
