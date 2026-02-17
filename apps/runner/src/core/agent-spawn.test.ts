import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoContext } from "./types.js";

const existsSyncMock = vi.fn<(path: string) => boolean>();
vi.mock("node:fs", () => ({
  existsSync: (...args: [string]) => existsSyncMock(...args),
}));

const readFileMock = vi.fn<(path: string, encoding: string) => Promise<string>>();
vi.mock("node:fs/promises", () => ({
  readFile: (...args: [string, string]) => readFileMock(...args),
}));

const loadConfigMock = vi.fn(() => ({}));
vi.mock("../../config/io.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

const resolveCliBackendConfigMock = vi.fn(() => null);
vi.mock("../../agents/cli-backends.js", () => ({
  resolveCliBackendConfig: (...args: [string, unknown]) => resolveCliBackendConfigMock(...args),
}));

import {
  buildPromptFromTemplate,
  loadSourcePreamble,
  resolveClaudeBin,
  resolveCliBin,
} from "./agent-spawn.js";

const baseRepo: RepoContext = {
  owner: "openclaw",
  repo: "openclaw",
  projectNumber: 42,
};

describe("resolveCliBin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns local entry when openclaw.mjs exists", () => {
    existsSyncMock.mockImplementation((p: string) => p.endsWith("openclaw.mjs"));

    const result = resolveCliBin();

    expect(result.command).toBe(process.execPath);
    expect(result.prefixArgs).toHaveLength(1);
    expect(result.prefixArgs[0]).toContain("openclaw.mjs");
  });

  it("returns dist entry when dist/entry.js exists but no local entry", () => {
    existsSyncMock.mockImplementation((p: string) => p.endsWith("dist/entry.js"));

    const result = resolveCliBin();

    expect(result.command).toBe(process.execPath);
    expect(result.prefixArgs).toHaveLength(1);
    expect(result.prefixArgs[0]).toContain("dist/entry.js");
  });

  it("returns global 'openclaw' when neither local nor dist exists", () => {
    existsSyncMock.mockReturnValue(false);

    const result = resolveCliBin();

    expect(result.command).toBe("openclaw");
    expect(result.prefixArgs).toEqual([]);
  });
});

describe("loadSourcePreamble", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns content when preamble file exists", async () => {
    readFileMock.mockResolvedValueOnce("You are working from GitHub.");

    const result = await loadSourcePreamble("github");

    expect(result).toBe("You are working from GitHub.");
    expect(readFileMock).toHaveBeenCalledWith(
      expect.stringContaining("apps/runner/src/sources/github/preamble.md"),
      "utf-8",
    );
  });

  it("returns null when preamble not found", async () => {
    readFileMock.mockRejectedValueOnce(new Error("ENOENT"));

    const result = await loadSourcePreamble("manual");

    expect(result).toBeNull();
  });
});

describe("resolveClaudeBin", () => {
  const originalClaudeBin = process.env.CLAUDE_BIN;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CLAUDE_BIN;
    loadConfigMock.mockReturnValue({});
    resolveCliBackendConfigMock.mockReturnValue(null);
  });

  afterEach(() => {
    if (originalClaudeBin === undefined) {
      delete process.env.CLAUDE_BIN;
    } else {
      process.env.CLAUDE_BIN = originalClaudeBin;
    }
  });

  it("prefers CLAUDE_BIN when it exists", () => {
    process.env.CLAUDE_BIN = "/tmp/claude-custom";
    existsSyncMock.mockImplementation((p: string) => p === "/tmp/claude-custom");

    const result = resolveClaudeBin();

    expect(result).toEqual({ command: "/tmp/claude-custom", prefixArgs: [] });
  });

  it("falls back to ~/.local/bin/claude when available", () => {
    existsSyncMock.mockImplementation((p: string) => p.endsWith(".local/bin/claude"));

    const result = resolveClaudeBin();

    expect(result.command).toContain(".local/bin/claude");
    expect(result.prefixArgs).toEqual([]);
  });

  it("uses configured cli backend command when it exists", () => {
    resolveCliBackendConfigMock.mockReturnValue({
      id: "claude-cli",
      config: { command: "/opt/custom/claude" },
    });
    existsSyncMock.mockImplementation((p: string) => p === "/opt/custom/claude");

    const result = resolveClaudeBin();

    expect(result).toEqual({ command: "/opt/custom/claude", prefixArgs: [] });
  });

  it("falls back to PATH lookup when no known path exists", () => {
    existsSyncMock.mockReturnValue(false);

    const result = resolveClaudeBin();

    expect(result).toEqual({ command: "claude", prefixArgs: [] });
  });
});

describe("buildPromptFromTemplate", () => {
  it("replaces {OWNER} and {REPO} from repo context", () => {
    const result = buildPromptFromTemplate("Owner: {OWNER}, Repo: {REPO}", {}, baseRepo);

    expect(result).toBe("Owner: openclaw, Repo: openclaw");
  });

  it("replaces {ISSUE_NUMBER} and {TITLE} from vars", () => {
    const result = buildPromptFromTemplate(
      "Issue #{ISSUE_NUMBER}: {TITLE}",
      { issueNumber: "99", title: "Fix login" },
      baseRepo,
    );

    expect(result).toBe("Issue #99: Fix login");
  });

  it("allows task vars to override repo-level vars", () => {
    const result = buildPromptFromTemplate("Owner: {OWNER}", { OWNER: "override-org" }, baseRepo);

    expect(result).toBe("Owner: override-org");
  });

  it("handles missing optional vars as empty strings", () => {
    const result = buildPromptFromTemplate("Issue #{ISSUE_NUMBER}: {TITLE}", {}, baseRepo);

    expect(result).toBe("Issue #: ");
  });

  it("replaces {PROJECT_NUMBER} from repo context", () => {
    const result = buildPromptFromTemplate("Project {PROJECT_NUMBER}", {}, baseRepo);

    expect(result).toBe("Project 42");
  });

  it("works with no repo context (empty defaults)", () => {
    const result = buildPromptFromTemplate("Owner: {OWNER}, Repo: {REPO}", {});

    expect(result).toBe("Owner: , Repo: ");
  });
});
