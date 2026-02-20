/**
 * HTTP client for the Flux MCP API.
 *
 * Covers all Phase 1 endpoints. Uses shared McpHttpError from http.ts.
 */
import type {
  JsonRecord,
  WhoamiResponse,
  RedeemResponse,
  AccessRequestResponse,
  AccessPollResponse,
  TaskListResponse,
  TaskCreateResponse,
  StreamListResponse,
  HealthResponse,
  OpenApiResponse,
} from "./types.js";
import { McpHttpError, extractErrorCode, safeMessage } from "./http.js";

export { McpHttpError } from "./http.js";

export class FluxApiClient {
  private readonly baseUrl: string;
  private readonly token: string | null;

  constructor(params: { baseUrl: string; token?: string | null }) {
    this.baseUrl = params.baseUrl.replace(/\/+$/, "");
    this.token = params.token ?? null;
  }

  private async request<T>(
    method: string,
    path: string,
    opts?: {
      query?: URLSearchParams;
      body?: JsonRecord | JsonRecord[];
      noAuth?: boolean;
    },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (opts?.query) {
      url.search = opts.query.toString();
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (!opts?.noAuth && this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }

    const res = await fetch(url.toString(), {
      method,
      headers,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      throw new McpHttpError(
        safeMessage(parsed) ||
          `HTTP ${res.status} ${method} ${url.pathname}${url.search ? `?${url.search}` : ""}`,
        { status: res.status, code: extractErrorCode(parsed), body: parsed },
      );
    }
    return parsed as T;
  }

  // ── Auth / Identity ────────────────────────────────────────────────────

  async whoami(): Promise<WhoamiResponse> {
    return this.request<WhoamiResponse>("GET", "/whoami");
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health", { noAuth: true });
  }

  async openapi(): Promise<OpenApiResponse> {
    return this.request<OpenApiResponse>("GET", "/openapi");
  }

  // ── Access ─────────────────────────────────────────────────────────────

  async accessRequest(body: {
    orgId: string;
    inviteCode: string;
    agentLabel?: string;
    agentMetadata?: JsonRecord;
  }): Promise<AccessRequestResponse> {
    return this.request<AccessRequestResponse>(
      "POST",
      "/agent-access/request",
      { body, noAuth: true },
    );
  }

  async accessRedeem(body: {
    orgId: string;
    inviteCode: string;
    agentLabel?: string;
    agentMetadata?: JsonRecord;
  }): Promise<RedeemResponse> {
    return this.request<RedeemResponse>("POST", "/agent-access/redeem", {
      body,
      noAuth: true,
    });
  }

  async accessPoll(
    requestId: string,
    pollSecret: string,
  ): Promise<AccessPollResponse> {
    const query = new URLSearchParams({ pollSecret });
    return this.request<AccessPollResponse>(
      "GET",
      `/agent-access/requests/${encodeURIComponent(requestId)}`,
      { query, noAuth: true },
    );
  }

  // ── Tasks ──────────────────────────────────────────────────────────────

  async listTasks(opts: {
    status?: string;
    limit?: number;
    streamId?: string;
    mode?: string;
    format?: string;
    backend?: string;
    costClass?: string;
  } = {}): Promise<TaskListResponse> {
    const query = new URLSearchParams();
    if (opts.status) query.set("status", opts.status);
    if (typeof opts.limit === "number") query.set("limit", String(opts.limit));
    if (opts.streamId) query.set("streamId", opts.streamId);
    if (opts.mode) query.set("mode", opts.mode);
    if (opts.format) query.set("format", opts.format);
    if (opts.backend) query.set("backend", opts.backend);
    if (opts.costClass) query.set("costClass", opts.costClass);
    return this.request<TaskListResponse>("GET", "/tasks", { query });
  }

  async createTask(body: {
    type: string;
    goal: string;
    input: string;
    streamId?: string;
    skillId?: string;
    priority?: number;
    executionBackend?: string;
    executionModel?: string;
    dependencies?: string[];
    contextFrom?: string[];
  }): Promise<TaskCreateResponse> {
    return this.request<TaskCreateResponse>("POST", "/tasks", { body });
  }

  // ── Streams ────────────────────────────────────────────────────────────

  async listStreams(opts: {
    status?: string;
  } = {}): Promise<StreamListResponse> {
    const query = new URLSearchParams();
    if (opts.status) query.set("status", opts.status);
    return this.request<StreamListResponse>("GET", "/streams", { query });
  }
}
