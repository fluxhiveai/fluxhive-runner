import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenClawGitHubCapabilityProvider } from "./provider-openclaw.js";

const loadConfigMock = vi.fn();
const buildGatewayConnectionDetailsMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("../../../config/config.js", () => ({
  loadConfig: vi.fn(() => loadConfigMock()),
}));

vi.mock("../../../gateway/call.js", () => ({
  buildGatewayConnectionDetails: vi.fn((args: unknown) => buildGatewayConnectionDetailsMock(args)),
}));

describe("createOpenClawGitHubCapabilityProvider", () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", fetchMock);
    loadConfigMock.mockReturnValue({
      gateway: {
        mode: "local",
        auth: { token: "gateway-token" },
      },
    });
    buildGatewayConnectionDetailsMock.mockReturnValue({
      url: "ws://127.0.0.1:18789",
    });
  });

  afterEach(() => {
    if (originalFetch) {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("lists project issues via gateway tools/invoke", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          content: [{ type: "text", text: "ok" }],
          details: {
            issues: [
              {
                number: 42,
                title: "Fix intake drift",
                projectStatus: "Todo",
                updatedAt: "2026-02-12T00:00:00.000Z",
              },
            ],
          },
        },
      }),
    });

    const provider = createOpenClawGitHubCapabilityProvider();
    const result = await provider.listProjectIssuesByStatus({
      config: {
        owner: "openclaw",
        repo: "openclaw",
        projectNumber: 7,
        pollIntervalSeconds: 60,
      },
      statuses: ["Todo"],
      auth: { kind: "token", token: "github-token" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/tools/invoke",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer gateway-token",
        }),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      args?: Record<string, unknown>;
    };
    expect(body.args).toMatchObject({
      owner: "openclaw",
      repo: "openclaw",
      projectNumber: 7,
      statuses: ["Todo"],
      token: "github-token",
    });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.number).toBe(42);
  });

  it("normalizes schema validation failures", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          content: [{ type: "text", text: "ok" }],
          details: {
            issues: [{ number: "42" }],
          },
        },
      }),
    });

    const provider = createOpenClawGitHubCapabilityProvider();
    await expect(
      provider.listProjectIssuesByStatus({
        config: {
          owner: "openclaw",
          repo: "openclaw",
          projectNumber: 7,
          pollIntervalSeconds: 60,
        },
        statuses: ["Todo"],
        auth: { kind: "token", token: "github-token" },
      }),
    ).rejects.toMatchObject({
      name: "GitHubCapabilityError",
      providerName: "openclaw",
      operation: "listProjectIssuesByStatus",
      category: "unknown",
      retryable: true,
    });
  });

  it("normalizes upstream auth errors from tools/invoke", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({
        ok: false,
        error: { message: "Unauthorized", type: "unauthorized" },
      }),
    });

    const provider = createOpenClawGitHubCapabilityProvider();
    await expect(
      provider.listProjectIssuesByStatus({
        config: {
          owner: "openclaw",
          repo: "openclaw",
          projectNumber: 7,
          pollIntervalSeconds: 60,
        },
        statuses: ["Todo"],
        auth: { kind: "token", token: "github-token" },
      }),
    ).rejects.toMatchObject({
      name: "GitHubCapabilityError",
      providerName: "openclaw",
      operation: "listProjectIssuesByStatus",
      category: "auth",
      retryable: false,
    });
  });

  it("posts issue comments via gateway tools/invoke", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          content: [{ type: "text", text: "ok" }],
          details: {
            ok: true,
            output: "https://github.com/openclaw/openclaw/issues/42#issuecomment-1",
          },
        },
      }),
    });

    const provider = createOpenClawGitHubCapabilityProvider();
    const result = await provider.postIssueComment({
      owner: "openclaw",
      repo: "openclaw",
      issueNumber: 42,
      body: "Ship it",
      auth: { kind: "token", token: "github-token" },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      action?: string;
      args?: Record<string, unknown>;
    };
    expect(body.action).toBe("add_comment");
    expect(body.args).toMatchObject({
      owner: "openclaw",
      repo: "openclaw",
      issueNumber: 42,
      body: "Ship it",
      token: "github-token",
    });
    expect(result.ok).toBe(true);
  });

  it("creates draft pull requests via gateway tools/invoke", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          content: [{ type: "text", text: "ok" }],
          details: {
            number: 77,
            url: "https://github.com/openclaw/openclaw/pull/77",
            state: "OPEN",
            isDraft: true,
            headRefName: "squads/feat/77",
            baseRefName: "main",
          },
        },
      }),
    });

    const provider = createOpenClawGitHubCapabilityProvider();
    const result = await provider.createDraftPr({
      owner: "openclaw",
      repo: "openclaw",
      title: "Add GitHub capability bridge",
      body: "Implements draft PR automation.",
      head: "squads/feat/77",
      base: "main",
      auth: { kind: "token", token: "github-token" },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      action?: string;
      args?: Record<string, unknown>;
    };
    expect(body.action).toBe("create_draft_pr");
    expect(body.args).toMatchObject({
      owner: "openclaw",
      repo: "openclaw",
      title: "[AI] Add GitHub capability bridge",
      body: "Implements draft PR automation.\n\n## Generated by Flux\n\n- This draft PR was generated by Flux automation.",
      head: "squads/feat/77",
      base: "main",
      token: "github-token",
    });
    expect(result.number).toBe(77);
    expect(result.url).toBe("https://github.com/openclaw/openclaw/pull/77");
  });

  it("posts pull request comments via gateway tools/invoke", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          content: [{ type: "text", text: "ok" }],
          details: {
            ok: true,
            output: "commented",
          },
        },
      }),
    });

    const provider = createOpenClawGitHubCapabilityProvider();
    const result = await provider.postPrComment({
      owner: "openclaw",
      repo: "openclaw",
      prNumber: 77,
      body: "Looks good.",
      auth: { kind: "token", token: "github-token" },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      action?: string;
      args?: Record<string, unknown>;
    };
    expect(body.action).toBe("add_pr_comment");
    expect(body.args).toMatchObject({
      owner: "openclaw",
      repo: "openclaw",
      prNumber: 77,
      body: "Looks good.",
      token: "github-token",
    });
    expect(result.ok).toBe(true);
  });

  it("submits pull request reviews via gateway tools/invoke", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          content: [{ type: "text", text: "ok" }],
          details: {
            ok: true,
            reviewEvent: "approve",
            output: "review submitted",
          },
        },
      }),
    });

    const provider = createOpenClawGitHubCapabilityProvider();
    const result = await provider.postPrReview({
      owner: "openclaw",
      repo: "openclaw",
      prNumber: 77,
      reviewEvent: "approve",
      auth: { kind: "token", token: "github-token" },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      action?: string;
      args?: Record<string, unknown>;
    };
    expect(body.action).toBe("submit_pr_review");
    expect(body.args).toMatchObject({
      owner: "openclaw",
      repo: "openclaw",
      prNumber: 77,
      reviewEvent: "approve",
      token: "github-token",
    });
    expect(result).toMatchObject({
      ok: true,
      reviewEvent: "approve",
    });
  });

  it("reads pull request checks via gateway tools/invoke", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          content: [{ type: "text", text: "ok" }],
          details: {
            prNumber: 77,
            url: "https://github.com/openclaw/openclaw/pull/77",
            overallStatus: "pending",
            checks: [
              { name: "build", status: "success" },
              { name: "test", status: "pending" },
            ],
          },
        },
      }),
    });

    const provider = createOpenClawGitHubCapabilityProvider();
    const result = await provider.getPrChecks({
      owner: "openclaw",
      repo: "openclaw",
      prNumber: 77,
      auth: { kind: "token", token: "github-token" },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      action?: string;
      args?: Record<string, unknown>;
    };
    expect(body.action).toBe("get_pr_checks");
    expect(body.args).toMatchObject({
      owner: "openclaw",
      repo: "openclaw",
      prNumber: 77,
      token: "github-token",
    });
    expect(result).toMatchObject({
      prNumber: 77,
      overallStatus: "pending",
    });
    expect(result.checks).toHaveLength(2);
  });
});
