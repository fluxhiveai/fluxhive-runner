import { z } from "zod";
import type { OpenClawConfig } from "../../../config/config.js";
import { loadConfig } from "../../../config/config.js";
import { buildGatewayConnectionDetails } from "../../../gateway/call.js";
import {
  createDraftPrResultSchema,
  getPrChecksResultSchema,
  listProjectIssuesByStatusResultSchema,
  postIssueCommentResultSchema,
  postPrCommentResultSchema,
  postPrReviewResultSchema,
  toolsInvokeErrorEnvelopeSchema,
  toolsInvokeSuccessEnvelopeSchema,
} from "./schema.js";
import { normalizeDraftPrBody, normalizeDraftPrTitle } from "./pr-conventions.js";
import {
  type GitHubAuth,
  type GitHubCapability,
  type GitHubCapabilityCreateDraftPrResult,
  type GitHubCapabilityGetPrChecksResult,
  type GitHubCapabilityPostIssueCommentResult,
  type GitHubCapabilityPostPrCommentResult,
  type GitHubCapabilityPostPrReviewResult,
  GitHubCapabilityError,
  type GitHubProviderErrorCategory,
} from "./types.js";

const providerName = "openclaw" as const;
const DEFAULT_TOOLS_INVOKE_SESSION_KEY = "main";

type HttpStatusError = Error & {
  status: number;
};

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeAuthToken(auth: GitHubAuth): string | undefined {
  if (auth.kind === "token") {
    return auth.token;
  }
  return auth.token;
}

function resolveGatewayCredential(config: OpenClawConfig): string | undefined {
  const isRemoteMode = config.gateway?.mode === "remote";
  const remote = isRemoteMode ? config.gateway?.remote : undefined;
  const authToken = asTrimmedString(config.gateway?.auth?.token);
  const authPassword = asTrimmedString(config.gateway?.auth?.password);
  const remoteToken = asTrimmedString(remote?.token);
  const remotePassword = asTrimmedString(remote?.password);

  const token = isRemoteMode
    ? remoteToken
    : (asTrimmedString(process.env.OPENCLAW_GATEWAY_TOKEN) ??
      asTrimmedString(process.env.CLAWDBOT_GATEWAY_TOKEN) ??
      authToken);

  const password =
    asTrimmedString(process.env.OPENCLAW_GATEWAY_PASSWORD) ??
    asTrimmedString(process.env.CLAWDBOT_GATEWAY_PASSWORD) ??
    (isRemoteMode ? remotePassword : authPassword);

  return token ?? password;
}

function resolveToolsInvokeUrl(config: OpenClawConfig): string {
  const wsUrl = new URL(buildGatewayConnectionDetails({ config }).url);
  wsUrl.protocol = wsUrl.protocol === "wss:" ? "https:" : "http:";
  wsUrl.pathname = "/tools/invoke";
  wsUrl.search = "";
  wsUrl.hash = "";
  return wsUrl.toString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function unwrapToolResultDetails(raw: unknown): unknown {
  const obj = asRecord(raw);
  if (!obj) {
    return raw;
  }
  // `tools/invoke` returns `result` objects that often look like:
  // { content: [...], details: { ...structured output... } }
  const details = obj.details;
  return details !== undefined ? details : raw;
}

function createHttpStatusError(status: number, message: string): HttpStatusError {
  const error = new Error(message) as HttpStatusError;
  error.status = status;
  return error;
}

function readHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function classifyProviderError(error: unknown): GitHubProviderErrorCategory {
  const status = readHttpStatus(error);
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status !== undefined && status >= 500) {
    return "server_error";
  }

  const message = String(error).toLowerCase();
  if (message.includes("rate limit") || message.includes("abuse detection")) {
    return "rate_limit";
  }
  if (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("forbidden") ||
    message.includes("unauthorized") ||
    message.includes("authentication") ||
    message.includes("credential")
  ) {
    return "auth";
  }
  if (message.includes("404") || message.includes("not found")) {
    return "not_found";
  }
  if (
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504")
  ) {
    return "server_error";
  }
  return "unknown";
}

function isRetryable(category: GitHubProviderErrorCategory): boolean {
  return category === "rate_limit" || category === "server_error" || category === "unknown";
}

async function invokeGitHubProjectTool(params: {
  config: OpenClawConfig;
  action: string;
  args: Record<string, unknown>;
}): Promise<unknown> {
  const gatewayCredential = resolveGatewayCredential(params.config);
  if (!gatewayCredential) {
    throw new Error("missing gateway auth credential for tools/invoke");
  }

  const toolsInvokeUrl = resolveToolsInvokeUrl(params.config);
  let response: Response;
  try {
    response = await fetch(toolsInvokeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gatewayCredential}`,
      },
      body: JSON.stringify({
        tool: "github_project",
        action: params.action,
        args: params.args,
        sessionKey: DEFAULT_TOOLS_INVOKE_SESSION_KEY,
      }),
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`tools/invoke fetch failed (${toolsInvokeUrl}): ${errMsg}`, { cause: error });
  }
  const payload = (await response.json()) as unknown;

  if (!response.ok) {
    const errorPayload = toolsInvokeErrorEnvelopeSchema.safeParse(payload);
    const message =
      errorPayload.success && errorPayload.data.error?.message
        ? errorPayload.data.error.message
        : `tools/invoke request failed with HTTP ${response.status}`;
    throw createHttpStatusError(response.status, message);
  }

  const parsed = toolsInvokeSuccessEnvelopeSchema.parse(payload);
  return unwrapToolResultDetails(parsed.result);
}

export function createOpenClawGitHubCapabilityProvider(): GitHubCapability {
  return {
    providerName,
    async listProjectIssuesByStatus({ config, statuses, auth }) {
      try {
        const gatewayConfig = loadConfig();
        const ghToken = normalizeAuthToken(auth);
        const rawResult = await invokeGitHubProjectTool({
          config: gatewayConfig,
          action: "list_project_issues_by_status",
          args: {
            owner: config.owner,
            repo: config.repo,
            ...(typeof config.projectNumber === "number"
              ? { projectNumber: config.projectNumber }
              : {}),
            statuses,
            ...(ghToken ? { token: ghToken } : {}),
          },
        });
        const parsed = listProjectIssuesByStatusResultSchema.parse(rawResult);
        return {
          issues: parsed.issues,
        };
      } catch (error: unknown) {
        const category = error instanceof z.ZodError ? "unknown" : classifyProviderError(error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new GitHubCapabilityError({
          providerName,
          operation: "listProjectIssuesByStatus",
          category,
          retryable: isRetryable(category),
          message: errorMessage,
          cause: error,
        });
      }
    },
    async createDraftPr({
      owner,
      repo,
      title,
      body,
      head,
      base,
      auth,
    }): Promise<GitHubCapabilityCreateDraftPrResult> {
      try {
        const gatewayConfig = loadConfig();
        const ghToken = normalizeAuthToken(auth);
        const normalizedTitle = normalizeDraftPrTitle(title);
        const normalizedBody = normalizeDraftPrBody(body);
        const rawResult = await invokeGitHubProjectTool({
          config: gatewayConfig,
          action: "create_draft_pr",
          args: {
            owner,
            repo,
            title: normalizedTitle,
            body: normalizedBody,
            head,
            ...(base ? { base } : {}),
            ...(ghToken ? { token: ghToken } : {}),
          },
        });
        const parsed = createDraftPrResultSchema.parse(rawResult);
        return {
          number: parsed.number,
          url: parsed.url,
          ...(parsed.state ? { state: parsed.state } : {}),
          ...(typeof parsed.isDraft === "boolean" ? { isDraft: parsed.isDraft } : {}),
          ...(parsed.headRefName ? { headRefName: parsed.headRefName } : {}),
          ...(parsed.baseRefName ? { baseRefName: parsed.baseRefName } : {}),
        };
      } catch (error: unknown) {
        const category = error instanceof z.ZodError ? "unknown" : classifyProviderError(error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new GitHubCapabilityError({
          providerName,
          operation: "createDraftPr",
          category,
          retryable: isRetryable(category),
          message: errorMessage,
          cause: error,
        });
      }
    },
    async postIssueComment({
      owner,
      repo,
      issueNumber,
      body,
      auth,
    }): Promise<GitHubCapabilityPostIssueCommentResult> {
      try {
        const gatewayConfig = loadConfig();
        const ghToken = normalizeAuthToken(auth);
        const rawResult = await invokeGitHubProjectTool({
          config: gatewayConfig,
          action: "add_comment",
          args: {
            owner,
            repo,
            issueNumber,
            body,
            ...(ghToken ? { token: ghToken } : {}),
          },
        });
        const parsed = postIssueCommentResultSchema.parse(rawResult);
        return {
          ok: parsed.ok,
          ...(parsed.output ? { output: parsed.output } : {}),
        };
      } catch (error: unknown) {
        const category = error instanceof z.ZodError ? "unknown" : classifyProviderError(error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new GitHubCapabilityError({
          providerName,
          operation: "postIssueComment",
          category,
          retryable: isRetryable(category),
          message: errorMessage,
          cause: error,
        });
      }
    },
    async postPrComment({
      owner,
      repo,
      prNumber,
      body,
      auth,
    }): Promise<GitHubCapabilityPostPrCommentResult> {
      try {
        const gatewayConfig = loadConfig();
        const ghToken = normalizeAuthToken(auth);
        const rawResult = await invokeGitHubProjectTool({
          config: gatewayConfig,
          action: "add_pr_comment",
          args: {
            owner,
            repo,
            prNumber,
            body,
            ...(ghToken ? { token: ghToken } : {}),
          },
        });
        const parsed = postPrCommentResultSchema.parse(rawResult);
        return {
          ok: parsed.ok,
          ...(parsed.output ? { output: parsed.output } : {}),
        };
      } catch (error: unknown) {
        const category = error instanceof z.ZodError ? "unknown" : classifyProviderError(error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new GitHubCapabilityError({
          providerName,
          operation: "postPrComment",
          category,
          retryable: isRetryable(category),
          message: errorMessage,
          cause: error,
        });
      }
    },
    async postPrReview({
      owner,
      repo,
      prNumber,
      reviewEvent,
      body,
      auth,
    }): Promise<GitHubCapabilityPostPrReviewResult> {
      try {
        const gatewayConfig = loadConfig();
        const ghToken = normalizeAuthToken(auth);
        const rawResult = await invokeGitHubProjectTool({
          config: gatewayConfig,
          action: "submit_pr_review",
          args: {
            owner,
            repo,
            prNumber,
            reviewEvent,
            ...(body ? { body } : {}),
            ...(ghToken ? { token: ghToken } : {}),
          },
        });
        const parsed = postPrReviewResultSchema.parse(rawResult);
        return {
          ok: parsed.ok,
          reviewEvent: parsed.reviewEvent,
          ...(parsed.output ? { output: parsed.output } : {}),
        };
      } catch (error: unknown) {
        const category = error instanceof z.ZodError ? "unknown" : classifyProviderError(error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new GitHubCapabilityError({
          providerName,
          operation: "postPrReview",
          category,
          retryable: isRetryable(category),
          message: errorMessage,
          cause: error,
        });
      }
    },
    async getPrChecks({ owner, repo, prNumber, auth }): Promise<GitHubCapabilityGetPrChecksResult> {
      try {
        const gatewayConfig = loadConfig();
        const ghToken = normalizeAuthToken(auth);
        const rawResult = await invokeGitHubProjectTool({
          config: gatewayConfig,
          action: "get_pr_checks",
          args: {
            owner,
            repo,
            prNumber,
            ...(ghToken ? { token: ghToken } : {}),
          },
        });
        const parsed = getPrChecksResultSchema.parse(rawResult);
        return {
          prNumber: parsed.prNumber,
          ...(parsed.url ? { url: parsed.url } : {}),
          ...(parsed.title ? { title: parsed.title } : {}),
          ...(parsed.state ? { state: parsed.state } : {}),
          ...(typeof parsed.isDraft === "boolean" ? { isDraft: parsed.isDraft } : {}),
          ...(parsed.headRefName ? { headRefName: parsed.headRefName } : {}),
          ...(parsed.baseRefName ? { baseRefName: parsed.baseRefName } : {}),
          ...(parsed.mergeStateStatus ? { mergeStateStatus: parsed.mergeStateStatus } : {}),
          ...(parsed.reviewDecision ? { reviewDecision: parsed.reviewDecision } : {}),
          overallStatus: parsed.overallStatus,
          checks: parsed.checks,
        };
      } catch (error: unknown) {
        const category = error instanceof z.ZodError ? "unknown" : classifyProviderError(error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new GitHubCapabilityError({
          providerName,
          operation: "getPrChecks",
          category,
          retryable: isRetryable(category),
          message: errorMessage,
          cause: error,
        });
      }
    },
  };
}
