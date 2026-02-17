import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/types.js";

type GatewayConnectionDetails = {
  url: string;
  token?: string;
};

export function buildGatewayConnectionDetails(args: { config?: OpenClawConfig }): GatewayConnectionDetails {
  const cfg = args.config ?? {};
  const gateway = cfg.gateway;
  const isRemote = gateway?.mode === "remote";

  const url =
    (isRemote ? gateway?.remote?.url : gateway?.url) ??
    process.env.OPENCLAW_GATEWAY_URL ??
    "http://127.0.0.1:8787/ws";

  const token =
    (isRemote ? gateway?.remote?.token : gateway?.auth?.token) ??
    process.env.OPENCLAW_GATEWAY_TOKEN;

  return { url, ...(token ? { token } : {}) };
}

export function randomIdempotencyKey(): string {
  return randomUUID();
}

export async function callGateway<T>(args: {
  method: string;
  params?: Record<string, unknown>;
  expectFinal?: boolean;
  timeoutMs?: number;
}): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = args.timeoutMs ?? 120_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const details = buildGatewayConnectionDetails({ config: undefined });
    const httpUrl = new URL(details.url);
    httpUrl.protocol = httpUrl.protocol === "wss:" ? "https:" : "http:";
    if (httpUrl.pathname === "/" || httpUrl.pathname.endsWith("/ws")) {
      httpUrl.pathname = "/rpc";
    }
    const response = await fetch(httpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(details.token ? { authorization: `Bearer ${details.token}` } : {}),
      },
      body: JSON.stringify({
        method: args.method,
        params: args.params ?? {},
        ...(args.expectFinal !== undefined ? { expectFinal: args.expectFinal } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gateway HTTP ${response.status}: ${body}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
