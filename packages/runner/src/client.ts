import type {
  JsonRecord,
  McpClaimResponse,
  McpCompleteStatus,
  McpHandshakeResponse,
  McpHeartbeatResponse,
  McpTaskListResponse,
  McpWhoamiResponse,
} from "./types.js";

export class McpHttpError extends Error {
  status: number;
  code?: string;
  body?: unknown;

  constructor(message: string, opts: { status: number; code?: string; body?: unknown }) {
    super(message);
    this.name = "McpHttpError";
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
  }
}

function extractErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const obj = payload as Record<string, unknown>;
  if (typeof obj.code === "string" && obj.code.length > 0) {
    return obj.code;
  }
  if (obj.error && typeof obj.error === "object") {
    const nested = obj.error as Record<string, unknown>;
    if (typeof nested.code === "string" && nested.code.length > 0) {
      return nested.code;
    }
  }
  return undefined;
}

function safeMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const obj = payload as Record<string, unknown>;
  if (typeof obj.message === "string" && obj.message.length > 0) {
    return obj.message;
  }
  if (obj.error && typeof obj.error === "object") {
    const nested = obj.error as Record<string, unknown>;
    if (typeof nested.message === "string" && nested.message.length > 0) {
      return nested.message;
    }
  }
  return undefined;
}

export type ListTaskOptions = {
  status?: string;
  limit?: number;
  mode?: string;
  format?: string;
  streamId?: string;
  backend?: string;
  costClass?: string;
};

export type ClaimTaskOptions = {
  runnerType: string;
  runnerVersion: string;
  machineId: string;
  runnerInstanceId: string;
  backend?: string;
  format?: string;
};

export class FluxMcpClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(params: { baseUrl: string; token: string }) {
    this.baseUrl = params.baseUrl.replace(/\/+$/, "");
    this.token = params.token;
  }

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

  async whoami(): Promise<McpWhoamiResponse> {
    return await this.request<McpWhoamiResponse>("GET", "/whoami");
  }

  async handshake(args: {
    runnerType: string;
    runnerVersion: string;
    machineId: string;
    runnerInstanceId: string;
    backend?: string;
  }): Promise<McpHandshakeResponse> {
    return await this.request<McpHandshakeResponse>("POST", "/handshake", { body: args });
  }

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

  async claimTask(taskId: string, args: ClaimTaskOptions): Promise<McpClaimResponse> {
    return await this.request<McpClaimResponse>("POST", `/tasks/${encodeURIComponent(taskId)}/claim`, {
      body: {
        ...args,
        format: args.format ?? "packet",
      },
    });
  }

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

export function wsUrlToHttpOrigin(wsUrl: string): string {
  const u = new URL(wsUrl);
  if (u.protocol === "wss:") return `https://${u.host}`;
  if (u.protocol === "ws:") return `http://${u.host}`;
  throw new Error(`Unsupported WS protocol in ${wsUrl}`);
}
