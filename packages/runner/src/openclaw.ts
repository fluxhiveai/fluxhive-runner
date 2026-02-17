import process from "node:process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { OpenClawResult } from "./types.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  expectFinal: boolean;
  timeout: ReturnType<typeof setTimeout>;
};

type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
};

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message?: string };
};

function isGatewayEventFrame(value: unknown): value is GatewayEventFrame {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as Record<string, unknown>;
  return v.type === "event" && typeof v.event === "string";
}

function isGatewayResponseFrame(value: unknown): value is GatewayResponseFrame {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as Record<string, unknown>;
  return v.type === "res" && typeof v.id === "string" && typeof v.ok === "boolean";
}

function asMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export type OpenClawClientOptions = {
  gatewayUrl: string;
  token?: string;
  password?: string;
  defaultAgentId?: string;
  clientName?: string;
  clientVersion?: string;
  instanceId?: string;
};

export class OpenClawClient extends EventEmitter {
  private readonly opts: OpenClawClientOptions;
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private connectPromise: Promise<void> | null = null;
  private connected = false;

  constructor(opts: OpenClawClientOptions) {
    super();
    this.opts = opts;
  }

  private flushPending(err: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private handleMessage(raw: string) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (isGatewayEventFrame(parsed)) {
      this.emit("event", parsed);
      if (parsed.event === "connect.challenge") {
        const payload =
          parsed.payload && typeof parsed.payload === "object"
            ? (parsed.payload as Record<string, unknown>)
            : {};
        const nonce = typeof payload.nonce === "string" ? payload.nonce : undefined;
        void this.sendConnect(nonce);
      }
      return;
    }
    if (!isGatewayResponseFrame(parsed)) {
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }
    const payload =
      parsed.payload && typeof parsed.payload === "object"
        ? (parsed.payload as Record<string, unknown>)
        : {};
    if (pending.expectFinal && payload.status === "accepted") {
      return;
    }
    this.pending.delete(parsed.id);
    clearTimeout(pending.timeout);
    if (!parsed.ok) {
      pending.reject(new Error(parsed.error?.message || "OpenClaw request failed"));
      return;
    }
    pending.resolve(parsed.payload);
  }

  private async sendConnect(nonce?: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const params: Record<string, unknown> = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: this.opts.clientName || "flux-runner",
        version: this.opts.clientVersion || "0.1.0",
        platform: process.platform,
        mode: "backend",
        instanceId: this.opts.instanceId || randomUUID(),
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      caps: [],
      auth: {
        ...(this.opts.token ? { token: this.opts.token } : {}),
        ...(this.opts.password ? { password: this.opts.password } : {}),
      },
    };
    if (nonce) {
      params.device = {
        // Keep nonce visible for servers that enforce challenge presence.
        // We intentionally do not manage device-key signatures in this bridge.
        nonce,
      };
    }
    await this.request("connect", params, { expectFinal: false, timeoutMs: 15_000 });
    this.connected = true;
  }

  async connect(): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return await this.connectPromise;
    }
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.opts.gatewayUrl, {
        handshakeTimeout: 10_000,
        maxPayload: 25 * 1024 * 1024,
      });
      this.ws = ws;
      let settled = false;
      let connectFallbackTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (connectFallbackTimer) {
          clearTimeout(connectFallbackTimer);
          connectFallbackTimer = null;
        }
      };

      ws.on("open", () => {
        connectFallbackTimer = setTimeout(() => {
          void this.sendConnect(undefined).catch((error) => {
            if (!settled) {
              settled = true;
              cleanup();
              reject(error instanceof Error ? error : new Error(asMessage(error)));
            }
          });
        }, 750);
      });
      ws.on("message", (data) => {
        this.handleMessage(String(data));
        if (this.connected && !settled) {
          settled = true;
          cleanup();
          resolve();
        }
      });
      ws.on("close", (code, reason) => {
        this.connected = false;
        this.ws = null;
        this.flushPending(new Error(`OpenClaw gateway closed (${code}): ${String(reason)}`));
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`OpenClaw gateway closed during connect (${code})`));
        }
      });
      ws.on("error", (error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error instanceof Error ? error : new Error(asMessage(error)));
        }
      });
    });

    const pendingConnect = this.connectPromise;
    try {
      await pendingConnect;
    } finally {
      this.connectPromise = null;
    }
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean; timeoutMs?: number },
  ): Promise<T> {
    await this.connect();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("OpenClaw gateway is not connected");
    }
    const id = randomUUID();
    const timeoutMs = Math.max(1000, Math.floor(opts?.timeoutMs ?? 60_000));
    const expectFinal = opts?.expectFinal === true;
    const responsePromise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OpenClaw request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (payload) => resolve(payload as T),
        reject,
        expectFinal,
        timeout,
      });
    });

    this.ws.send(
      JSON.stringify({
        type: "req",
        id,
        method,
        params,
      }),
    );
    return await responsePromise;
  }

  async ping(): Promise<boolean> {
    try {
      await this.request("health", undefined, { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async execute(opts: {
    prompt: string;
    sessionKey: string;
    agentId?: string;
    timeoutSec?: number;
    deliver?: boolean;
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string;
    onEvent?: (event: GatewayEventFrame) => void;
    abortSignal?: AbortSignal;
  }): Promise<OpenClawResult> {
    const startedAt = Date.now();
    const eventHandler = opts.onEvent ? (event: GatewayEventFrame) => opts.onEvent?.(event) : null;
    if (eventHandler) {
      this.on("event", eventHandler);
    }

    const run = this.request<Record<string, unknown>>(
      "agent",
      {
        message: opts.prompt,
        sessionKey: opts.sessionKey,
        agentId: opts.agentId ?? this.opts.defaultAgentId,
        timeout: opts.timeoutSec ?? 120,
        deliver: opts.deliver ?? false,
        ...(opts.channel ? { channel: opts.channel } : {}),
        ...(opts.to ? { to: opts.to } : {}),
        ...(opts.accountId ? { accountId: opts.accountId } : {}),
        ...(opts.threadId ? { threadId: opts.threadId } : {}),
        idempotencyKey: randomUUID(),
      },
      {
        expectFinal: true,
        timeoutMs: Math.max(30_000, (opts.timeoutSec ?? 120) * 1000 + 30_000),
      },
    );

    const aborted =
      opts.abortSignal && !opts.abortSignal.aborted
        ? new Promise<Record<string, unknown>>((_, reject) => {
            opts.abortSignal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          })
        : null;

    let response: Record<string, unknown>;
    try {
      response = aborted ? await Promise.race([run, aborted]) : await run;
    } finally {
      if (eventHandler) {
        this.off("event", eventHandler);
      }
    }

    const result =
      response.result && typeof response.result === "object"
        ? (response.result as Record<string, unknown>)
        : response;
    const payloadsRaw = Array.isArray(result.payloads) ? result.payloads : [];
    const payloads = payloadsRaw
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      .map((entry) => ({
        text: typeof entry.text === "string" ? entry.text : undefined,
        mediaUrl: typeof entry.mediaUrl === "string" ? entry.mediaUrl : undefined,
        isError: Boolean(entry.isError),
      }));
    const usageRaw =
      result.usage && typeof result.usage === "object"
        ? (result.usage as Record<string, unknown>)
        : null;

    return {
      runId: typeof response.runId === "string" ? response.runId : undefined,
      payloads,
      usage: usageRaw
        ? {
            input: typeof usageRaw.input === "number" ? usageRaw.input : undefined,
            output: typeof usageRaw.output === "number" ? usageRaw.output : undefined,
            total: typeof usageRaw.total === "number" ? usageRaw.total : undefined,
          }
        : undefined,
      model: typeof result.model === "string" ? result.model : undefined,
      provider: typeof result.provider === "string" ? result.provider : undefined,
      durationMs:
        typeof result.durationMs === "number" ? result.durationMs : Math.max(0, Date.now() - startedAt),
      aborted: opts.abortSignal?.aborted === true,
    };
  }

  close() {
    this.connected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.flushPending(new Error("OpenClaw client closed"));
  }
}
