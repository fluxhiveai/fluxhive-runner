/**
 * Shared HTTP error infrastructure used by both FluxApiClient and FluxMcpClient.
 */

/** Structured error for non-2xx API responses. */
export class McpHttpError extends Error {
  status: number;
  code?: string;
  body?: unknown;

  constructor(
    message: string,
    opts: { status: number; code?: string; body?: unknown },
  ) {
    super(message);
    this.name = "McpHttpError";
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
  }
}

/** Extracts a machine-readable error code from an API error body (top-level or nested). */
export function extractErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.code === "string" && obj.code.length > 0) return obj.code;
  if (obj.error && typeof obj.error === "object") {
    const nested = obj.error as Record<string, unknown>;
    if (typeof nested.code === "string" && nested.code.length > 0)
      return nested.code;
  }
  return undefined;
}

/** Extracts a human-readable error message from an API error body. */
export function safeMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.message === "string" && obj.message.length > 0)
    return obj.message;
  if (obj.error && typeof obj.error === "object") {
    const nested = obj.error as Record<string, unknown>;
    if (typeof nested.message === "string" && nested.message.length > 0)
      return nested.message;
  }
  return undefined;
}
