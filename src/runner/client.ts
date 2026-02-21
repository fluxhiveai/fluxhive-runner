/**
 * HTTP client for the Flux MCP API.
 *
 * FluxMcpClient wraps all authenticated REST calls to the Flux server:
 * bootstrap (whoami, handshake, hello), task lifecycle (list, claim,
 * heartbeat, complete, escalate), and push setup (mintPushTicket).
 *
 * Every request includes Bearer auth and returns typed responses.
 * Non-2xx responses are thrown as McpHttpError with status, code, and body.
 */
import type {
  JsonRecord,
  McpClaimResponse,
  McpCompleteStatus,
  McpHandshakeResponse,
  McpHeartbeatResponse,
  McpTaskListResponse,
  McpWhoamiResponse,
} from "../types.js";
import { McpHttpError, extractErrorCode, safeMessage } from "../http.js";

export { McpHttpError } from "../http.js";

/** Options for listing tasks — filters by status, backend, stream, etc. */
export type ListTaskOptions = {
  status?: string;
  limit?: number;
  mode?: string;
  format?: string;
  streamId?: string;
  backend?: string;
  costClass?: string;
};

/** Options passed when claiming a task — identifies this runner to the server. */
export type ClaimTaskOptions = {
  runnerType: string;
  runnerVersion: string;
  machineId: string;
  runnerInstanceId: string;
  backend?: string;
  format?: string;
};

/**
 * Authenticated HTTP client for all Flux MCP API endpoints.
 * Instantiated once at startup and shared across the cadence loop,
 * push client, and task executor.
 */
export class FluxMcpClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(params: { baseUrl: string; token: string }) {
    this.baseUrl = params.baseUrl.replace(/\/+$/, "");
    this.token = params.token;
  }

  /** Generic JSON request helper — sends auth header, parses response, throws McpHttpError on failure. */
  private async request<T>(
    method: string,
    path: string,
    opts?: { query?: URLSearchParams; body?: JsonRecord | JsonRecord[] },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (opts?.query) {
      url.search = opts.query.toString();
    }
    const res = await fetch(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
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

  /** Returns the agent identity and server version for the current token. */
  async whoami(): Promise<McpWhoamiResponse> {
    return await this.request<McpWhoamiResponse>("GET", "/whoami");
  }

  /** Registers this runner with the server and receives poll/push configuration. */
  async handshake(args: {
    runnerType: string;
    runnerVersion: string;
    machineId: string;
    runnerInstanceId: string;
    backend?: string;
  }): Promise<McpHandshakeResponse> {
    return await this.request<McpHandshakeResponse>("POST", "/handshake", { body: args });
  }

  /** Posts a hello message to the org chat — lets the team know the runner is online. */
  async hello(): Promise<void> {
    await this.request<JsonRecord>("POST", "/hello", { body: {} });
  }

  /** Notifies the server that this agent is going offline (best-effort). */
  async disconnect(): Promise<void> {
    await this.request<JsonRecord>("POST", "/disconnect", { body: {} });
  }

  /** Lists tasks matching the given filters (status, backend, stream, etc.). */
  async listTasks(opts: ListTaskOptions = {}): Promise<McpTaskListResponse> {
    const query = new URLSearchParams();
    if (opts.status) query.set("status", opts.status);
    if (typeof opts.limit === "number") query.set("limit", String(opts.limit));
    if (opts.mode) query.set("mode", opts.mode);
    if (opts.format) query.set("format", opts.format);
    if (opts.streamId) query.set("streamId", opts.streamId);
    if (opts.backend) query.set("backend", opts.backend);
    if (opts.costClass) query.set("costClass", opts.costClass);
    return await this.request<McpTaskListResponse>("GET", "/tasks", { query });
  }

  /** Claims a task for execution, returning a session ID and the task packet. */
  async claimTask(taskId: string, args: ClaimTaskOptions): Promise<McpClaimResponse> {
    return await this.request<McpClaimResponse>("POST", `/tasks/${encodeURIComponent(taskId)}/claim`, {
      body: {
        ...args,
        format: args.format ?? "packet",
      },
    });
  }

  /** Sends a heartbeat for an in-progress task; server may signal abort/cancel. */
  async heartbeat(
    taskId: string,
    sessionId: string,
    args?: { phase?: string; progress?: string },
  ): Promise<McpHeartbeatResponse> {
    return await this.request<McpHeartbeatResponse>(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/heartbeat`,
      {
        body: {
          sessionId,
          ...(args?.phase ? { phase: args.phase } : {}),
          ...(args?.progress ? { progress: args.progress } : {}),
        },
      },
    );
  }

  /** Reports task completion (done/failed/cancelled) with output and metrics. */
  async completeTask(
    taskId: string,
    sessionId: string,
    result: {
      status: McpCompleteStatus;
      output: string;
      tokensUsed?: number;
      costUsd?: number;
      durationMs?: number;
    },
  ): Promise<JsonRecord> {
    return await this.request<JsonRecord>("POST", `/tasks/${encodeURIComponent(taskId)}/complete`, {
      body: {
        sessionId,
        ...result,
      },
    });
  }

  /** Escalates a task to a human operator (e.g. when approval is needed). */
  async escalateTask(
    taskId: string,
    sessionId: string,
    reason: string,
    suggestedAction?: string,
  ): Promise<JsonRecord> {
    return await this.request<JsonRecord>("POST", `/tasks/${encodeURIComponent(taskId)}/escalate`, {
      body: {
        sessionId,
        reason,
        ...(suggestedAction ? { suggestedAction } : {}),
      },
    });
  }

  /** Mints a short-lived ticket for authenticating to the push WebSocket. */
  async mintPushTicket(args: {
    wsUrl: string;
    streamId?: string;
    backend?: string;
    costClass?: string;
    runnerType: string;
    runnerVersion: string;
    runnerInstanceId: string;
    machineId: string;
  }): Promise<{ ticket: string }> {
    const origin = wsUrlToHttpOrigin(args.wsUrl);
    const endpoint = `${origin}/mcp/v1/push-ticket`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        filters: {
          streamId: args.streamId ?? null,
          backend: args.backend ?? null,
          costClass: args.costClass ?? null,
        },
        runnerType: args.runnerType,
        runnerVersion: args.runnerVersion,
        runnerInstanceId: args.runnerInstanceId,
        machineId: args.machineId,
      }),
    });
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok || !parsed || typeof parsed !== "object" || typeof (parsed as JsonRecord).ticket !== "string") {
      throw new McpHttpError(`Failed to mint push ticket (${res.status})`, { status: res.status, body: parsed });
    }
    return { ticket: (parsed as JsonRecord).ticket as string };
  }
}

/** Converts a WebSocket URL (ws:// or wss://) to its HTTP origin for REST calls. */
export function wsUrlToHttpOrigin(wsUrl: string): string {
  const u = new URL(wsUrl);
  if (u.protocol === "wss:") return `https://${u.host}`;
  if (u.protocol === "ws:") return `http://${u.host}`;
  throw new Error(`Unsupported WS protocol in ${wsUrl}`);
}
