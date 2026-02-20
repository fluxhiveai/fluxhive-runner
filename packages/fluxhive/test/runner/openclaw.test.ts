import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mock WebSocket — auto-opens on next microtask
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 1;
  sentMessages: string[] = [];

  constructor(
    public url: string,
    public opts?: Record<string, unknown>,
  ) {
    super();
    queueMicrotask(() => this.emit("open"));
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = 3;
    this.emit("close", 1000, "normal");
  }
}

vi.mock("ws", () => ({
  __esModule: true,
  default: MockWebSocket,
}));

vi.mock("../../src/runner/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: () => ({
    deviceId: "dev-1",
    privateKeyPem: "fake-pem",
    publicKeyPem: "fake-pub-pem",
  }),
  publicKeyBase64Url: () => "fake-pubkey-b64",
  buildDeviceAuthPayload: (p: Record<string, unknown>) => JSON.stringify(p),
  signDevicePayload: () => "fake-signature",
  loadGatewayToken: () => "gw-token",
  loadDeviceToken: () => null,
  storeDeviceToken: vi.fn(),
  clearDeviceToken: vi.fn(),
}));

const { OpenClawClient } = await import("../../src/runner/openclaw.ts");

function getWs(client: InstanceType<typeof OpenClawClient>): MockWebSocket {
  return (client as unknown as { ws: MockWebSocket }).ws;
}

function sendResponse(ws: MockWebSocket, id: string, ok: boolean, payload?: unknown) {
  ws.emit(
    "message",
    JSON.stringify({
      type: "res",
      id,
      ok,
      payload,
      ...(ok ? {} : { error: { message: "fail" } }),
    }),
  );
}

function lastSentId(ws: MockWebSocket): string {
  const last = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]) as Record<string, unknown>;
  return last.id as string;
}

/** Flush microtasks so sendConnect's `await` can resume and set this.connected. */
async function flush() {
  await new Promise((r) => setTimeout(r, 5));
}

/**
 * After the connect response resolves the pending promise, sendConnect sets
 * `this.connected = true` on the next microtask. The connect() settle check
 * runs on the NEXT incoming message. So we send a dummy message to trigger it.
 */
function nudge(ws: MockWebSocket) {
  ws.emit("message", JSON.stringify({ type: "unknown" }));
}

/** Full connect helper: create client, connect with challenge flow. */
async function connectedClient(opts?: Record<string, unknown>) {
  const client = new OpenClawClient({
    gatewayUrl: "ws://localhost:8080",
    defaultAgentId: "agent-1",
    ...opts,
  });
  const p = client.connect();
  await flush();
  const ws = getWs(client);

  // Gateway sends challenge
  ws.emit(
    "message",
    JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n1" } }),
  );

  // Wait for sendConnect to build + send the connect request synchronously
  await flush();
  const id = lastSentId(ws);

  // Send connect response
  sendResponse(ws, id, true, { auth: {} });

  // Flush microtask so sendConnect sets this.connected = true, then nudge
  await flush();
  nudge(ws);
  await p;

  return { client, ws };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenClawClient", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("connect", () => {
    it("connects via challenge handshake", async () => {
      const { client, ws } = await connectedClient();
      expect(ws.sentMessages.length).toBeGreaterThanOrEqual(1);
      const sent = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]) as Record<string, unknown>;
      expect(sent.method).toBe("connect");
      client.close();
    });

    it("returns immediately if already connected", async () => {
      const { client } = await connectedClient();
      await client.connect(); // should not throw or hang
      client.close();
    });

    it("rejects on WS error", async () => {
      const client = new OpenClawClient({ gatewayUrl: "ws://localhost:8080" });
      const p = client.connect();
      await flush();
      getWs(client).emit("error", new Error("connection refused"));
      await expect(p).rejects.toThrow("connection refused");
    });

    it("rejects on WS close during connect", async () => {
      const client = new OpenClawClient({ gatewayUrl: "ws://localhost:8080" });
      const p = client.connect();
      await flush();
      getWs(client).emit("close", 1006, "abnormal");
      await expect(p).rejects.toThrow(/closed during connect/);
    });

    it("stores device token from connect response", async () => {
      const { storeDeviceToken } = await import("../../src/runner/device-identity.js");
      const client = new OpenClawClient({ gatewayUrl: "ws://localhost:8080" });
      const p = client.connect();
      await flush();
      const ws = getWs(client);

      ws.emit(
        "message",
        JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }),
      );
      await flush();
      const id = lastSentId(ws);
      sendResponse(ws, id, true, {
        auth: { deviceToken: "dt-new", scopes: ["op.read"], role: "operator" },
      });
      await flush();
      nudge(ws);
      await p;

      expect(storeDeviceToken).toHaveBeenCalledWith("dev-1", "operator", "dt-new", ["op.read"]);
      client.close();
    });
  });

  describe("request", () => {
    it("sends request and resolves on success", async () => {
      const { client, ws } = await connectedClient();
      const p = client.request("test.method", { key: "val" });
      await flush();
      const id = lastSentId(ws);
      sendResponse(ws, id, true, { result: "ok" });
      expect(await p).toEqual({ result: "ok" });
      client.close();
    });

    it("rejects on error response", async () => {
      const { client, ws } = await connectedClient();
      const p = client.request("test.fail");
      await flush();
      sendResponse(ws, lastSentId(ws), false);
      await expect(p).rejects.toThrow("fail");
      client.close();
    });

    it("times out if no response", async () => {
      const { client } = await connectedClient();
      const p = client.request("slow", undefined, { timeoutMs: 1000 });
      await expect(p).rejects.toThrow(/timeout/);
      client.close();
    }, 10_000);

    it("skips intermediate accepted in expectFinal mode", async () => {
      const { client, ws } = await connectedClient();
      const p = client.request("agent", {}, { expectFinal: true });
      await flush();
      const id = lastSentId(ws);

      // Intermediate accepted — should be ignored
      ws.emit(
        "message",
        JSON.stringify({ type: "res", id, ok: true, payload: { status: "accepted" } }),
      );

      // Final response
      ws.emit(
        "message",
        JSON.stringify({ type: "res", id, ok: true, payload: { status: "done", data: 1 } }),
      );

      const result = await p;
      expect(result).toEqual({ status: "done", data: 1 });
      client.close();
    });
  });

  describe("ping", () => {
    it("returns true on success", async () => {
      const { client, ws } = await connectedClient();
      const p = client.ping();
      await flush();
      sendResponse(ws, lastSentId(ws), true, {});
      expect(await p).toBe(true);
      client.close();
    });

    it("returns false on error", async () => {
      const { client, ws } = await connectedClient();
      const p = client.ping();
      await flush();
      sendResponse(ws, lastSentId(ws), false);
      expect(await p).toBe(false);
      client.close();
    });
  });

  describe("execute", () => {
    it("extracts payloads and usage", async () => {
      const { client, ws } = await connectedClient();
      const p = client.execute({ prompt: "Hello", sessionKey: "s1", timeoutSec: 10 });
      await flush();
      const id = lastSentId(ws);

      // Intermediate accepted
      ws.emit(
        "message",
        JSON.stringify({ type: "res", id, ok: true, payload: { status: "accepted" } }),
      );

      // Final result
      ws.emit(
        "message",
        JSON.stringify({
          type: "res",
          id,
          ok: true,
          payload: {
            result: {
              payloads: [{ text: "output", isError: false }],
              usage: { input: 10, output: 20, total: 30 },
              model: "claude-3",
              provider: "anthropic",
              durationMs: 500,
            },
          },
        }),
      );

      const result = await p;
      expect(result.payloads).toEqual([
        { text: "output", mediaUrl: undefined, isError: false },
      ]);
      expect(result.usage).toEqual({ input: 10, output: 20, total: 30 });
      expect(result.model).toBe("claude-3");
      client.close();
    });

    it("handles abort signal", async () => {
      const { client } = await connectedClient();
      const ac = new AbortController();
      const p = client.execute({ prompt: "Hello", sessionKey: "s1", abortSignal: ac.signal });
      await flush();
      ac.abort();
      await expect(p).rejects.toThrow("aborted");
      client.close();
    });

    it("calls onEvent handler for gateway events", async () => {
      const { client, ws } = await connectedClient();
      const events: unknown[] = [];
      const p = client.execute({
        prompt: "Hello",
        sessionKey: "s1",
        onEvent: (e) => events.push(e),
      });
      await flush();
      const id = lastSentId(ws);

      // Emit progress event
      ws.emit(
        "message",
        JSON.stringify({ type: "event", event: "agent.progress", payload: { step: 1 } }),
      );

      // Final result
      ws.emit(
        "message",
        JSON.stringify({ type: "res", id, ok: true, payload: { result: { payloads: [] } } }),
      );

      const result = await p;
      expect(events).toHaveLength(1);
      expect(result.payloads).toEqual([]);
      client.close();
    });

    it("handles empty result payload gracefully", async () => {
      const { client, ws } = await connectedClient();
      const p = client.execute({ prompt: "Hello", sessionKey: "s1" });
      await flush();
      const id = lastSentId(ws);
      ws.emit(
        "message",
        JSON.stringify({ type: "res", id, ok: true, payload: {} }),
      );
      const result = await p;
      expect(result.payloads).toEqual([]);
      client.close();
    });
  });

  describe("handleMessage edge cases", () => {
    it("ignores non-JSON messages", async () => {
      const { client, ws } = await connectedClient();
      ws.emit("message", "not json{{{");
      // Should not throw
      client.close();
    });

    it("ignores responses with no matching pending", async () => {
      const { client, ws } = await connectedClient();
      ws.emit(
        "message",
        JSON.stringify({ type: "res", id: "unknown-id", ok: true, payload: {} }),
      );
      // Should not throw
      client.close();
    });

    it("ignores non-event non-response frames", async () => {
      const { client, ws } = await connectedClient();
      ws.emit("message", JSON.stringify({ type: "weird", data: 123 }));
      client.close();
    });
  });

  describe("close", () => {
    it("flushes pending requests", async () => {
      const { client, ws } = await connectedClient();
      const p = client.request("slow");
      await flush();
      client.close();
      await expect(p).rejects.toThrow(/closed/);
    });

    it("handles close when no WS is connected", () => {
      const client = new OpenClawClient({ gatewayUrl: "ws://localhost:8080" });
      client.close(); // should not throw
    });
  });
});
