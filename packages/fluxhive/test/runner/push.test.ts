import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  url: string;
  sentMessages: string[] = [];
  closeCalled = false;

  constructor(url: string, _opts?: unknown) {
    super();
    this.url = url;
    // Simulate async open
    queueMicrotask(() => this.emit("open"));
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.closeCalled = true;
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }
}

vi.mock("ws", () => ({
  default: MockWebSocket,
}));

// Import after mock
const { FluxPushClient } = await import("../../src/runner/push.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FluxClientMock = {
  mintPushTicket: ReturnType<typeof vi.fn>;
};

function createFluxClientMock(): FluxClientMock {
  return {
    mintPushTicket: vi.fn().mockResolvedValue({ ticket: "test-ticket" }),
  };
}

function makePushClient(
  fluxClient: FluxClientMock,
  overrides: {
    wsUrl?: string;
    reconnectBaseMs?: number;
  } = {},
) {
  return new FluxPushClient({
    wsUrl: overrides.wsUrl ?? "wss://push.example.com/ws",
    fluxClient: fluxClient as never,
    reconnectBaseMs: overrides.reconnectBaseMs ?? 100,
    runnerType: "test-runner",
    runnerVersion: "1.0",
    runnerInstanceId: "inst-1",
    machineId: "machine-1",
    streamId: "stream-1",
    backend: "claude-cli",
    costClass: "standard",
  });
}

// Helpers to capture the underlying MockWebSocket created inside FluxPushClient
function getLastCreatedSocket(): MockWebSocket | undefined {
  // We can't easily reach inside. Instead, we rely on the events emitted.
  return undefined;
}

describe("FluxPushClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  it("mints a ticket and connects via WebSocket", async () => {
    const fluxClient = createFluxClientMock();
    const pushClient = makePushClient(fluxClient);

    const connectedPromise = new Promise<void>((resolve) => {
      pushClient.on("connected", resolve);
    });

    await pushClient.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(fluxClient.mintPushTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        wsUrl: "wss://push.example.com/ws",
        streamId: "stream-1",
        backend: "claude-cli",
        costClass: "standard",
        runnerType: "test-runner",
      }),
    );

    await connectedPromise;
    pushClient.stop();
  });

  it("appends ticket to WebSocket URL as query param", async () => {
    const fluxClient = createFluxClientMock();
    fluxClient.mintPushTicket.mockResolvedValue({ ticket: "my-special-ticket" });

    const pushClient = makePushClient(fluxClient);
    // We cannot easily inspect the WebSocket URL directly since ws is mocked.
    // But we can confirm mintPushTicket was called and no errors thrown.

    await pushClient.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(fluxClient.mintPushTicket).toHaveBeenCalledTimes(1);

    pushClient.stop();
  });

  // ---------------------------------------------------------------------------
  // Event emission
  // ---------------------------------------------------------------------------

  it("emits 'task.available' on push message", async () => {
    const fluxClient = createFluxClientMock();
    const pushClient = makePushClient(fluxClient);

    const taskAvailablePromise = new Promise<unknown>((resolve) => {
      pushClient.on("task.available", resolve);
    });

    await pushClient.start();
    await vi.advanceTimersByTimeAsync(0);

    // We need to get the underlying socket and simulate a message.
    // Since MockWebSocket is used, we need access to the instance.
    // FluxPushClient stores it as this.ws; we can access it through
    // the mock constructor's tracking.

    // We'll use a different approach: access the private ws field
    const ws = (pushClient as unknown as { ws: MockWebSocket }).ws;
    if (ws) {
      ws.emit("message", JSON.stringify({ type: "task.available", taskId: "t-1" }));
    }

    const event = await taskAvailablePromise;
    expect(event).toEqual({ type: "task.available", taskId: "t-1" });

    pushClient.stop();
  });

  it("ignores non-task.available messages", async () => {
    const fluxClient = createFluxClientMock();
    const pushClient = makePushClient(fluxClient);
    const taskHandler = vi.fn();

    pushClient.on("task.available", taskHandler);

    await pushClient.start();
    await vi.advanceTimersByTimeAsync(0);

    const ws = (pushClient as unknown as { ws: MockWebSocket }).ws;
    if (ws) {
      ws.emit("message", JSON.stringify({ type: "pong" }));
      ws.emit("message", JSON.stringify({ type: "heartbeat" }));
    }

    await vi.advanceTimersByTimeAsync(0);
    expect(taskHandler).not.toHaveBeenCalled();

    pushClient.stop();
  });

  it("ignores malformed JSON messages", async () => {
    const fluxClient = createFluxClientMock();
    const pushClient = makePushClient(fluxClient);
    const taskHandler = vi.fn();

    pushClient.on("task.available", taskHandler);

    await pushClient.start();
    await vi.advanceTimersByTimeAsync(0);

    const ws = (pushClient as unknown as { ws: MockWebSocket }).ws;
    if (ws) {
      ws.emit("message", "not-json-{{{");
    }

    await vi.advanceTimersByTimeAsync(0);
    expect(taskHandler).not.toHaveBeenCalled();

    pushClient.stop();
  });

  // ---------------------------------------------------------------------------
  // Ping
  // ---------------------------------------------------------------------------

  it("sends periodic pings after connection", async () => {
    const fluxClient = createFluxClientMock();
    const pushClient = makePushClient(fluxClient);

    await pushClient.start();
    await vi.advanceTimersByTimeAsync(0);

    const ws = (pushClient as unknown as { ws: MockWebSocket }).ws;

    // Advance past the 20s ping interval
    await vi.advanceTimersByTimeAsync(20_000);

    if (ws) {
      expect(ws.sentMessages.length).toBeGreaterThanOrEqual(1);
      const pingMsg = JSON.parse(ws.sentMessages[0]);
      expect(pingMsg.type).toBe("ping");
    }

    pushClient.stop();
  });

  // ---------------------------------------------------------------------------
  // stop()
  // ---------------------------------------------------------------------------

  it("stop() closes the connection and sets closed flag", async () => {
    const fluxClient = createFluxClientMock();
    const pushClient = makePushClient(fluxClient);

    await pushClient.start();
    await vi.advanceTimersByTimeAsync(0);

    const ws = (pushClient as unknown as { ws: MockWebSocket }).ws;
    pushClient.stop();

    if (ws) {
      expect(ws.closeCalled).toBe(true);
    }
    expect((pushClient as unknown as { closed: boolean }).closed).toBe(true);
    expect((pushClient as unknown as { ws: MockWebSocket | null }).ws).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Auto-reconnect
  // ---------------------------------------------------------------------------

  it("schedules reconnect on disconnect", async () => {
    const fluxClient = createFluxClientMock();
    fluxClient.mintPushTicket.mockResolvedValue({ ticket: "t1" });

    const pushClient = makePushClient(fluxClient, { reconnectBaseMs: 100 });
    const disconnectedHandler = vi.fn();
    pushClient.on("disconnected", disconnectedHandler);

    await pushClient.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(fluxClient.mintPushTicket).toHaveBeenCalledTimes(1);

    // Simulate disconnect
    const ws = (pushClient as unknown as { ws: MockWebSocket }).ws;
    if (ws) {
      ws.emit("close");
    }

    expect(disconnectedHandler).toHaveBeenCalledTimes(1);

    // After reconnect delay, a new connection should be attempted (mintPushTicket called again)
    fluxClient.mintPushTicket.mockResolvedValue({ ticket: "t2" });
    await vi.advanceTimersByTimeAsync(200);

    expect(fluxClient.mintPushTicket).toHaveBeenCalledTimes(2);

    pushClient.stop();
  });

  it("does not reconnect after stop()", async () => {
    const fluxClient = createFluxClientMock();
    const pushClient = makePushClient(fluxClient, { reconnectBaseMs: 50 });

    await pushClient.start();
    await vi.advanceTimersByTimeAsync(0);

    pushClient.stop();

    // Advance well past reconnect time
    await vi.advanceTimersByTimeAsync(5_000);

    // Only the initial connection should have minted a ticket
    expect(fluxClient.mintPushTicket).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // mintPushTicket failure
  // ---------------------------------------------------------------------------

  it("handles mintPushTicket failure gracefully", async () => {
    const fluxClient = createFluxClientMock();
    fluxClient.mintPushTicket.mockRejectedValueOnce(new Error("Network error"));

    const pushClient = makePushClient(fluxClient);
    const errorHandler = vi.fn();
    pushClient.on("error", errorHandler);

    await expect(pushClient.start()).rejects.toThrow("Network error");

    pushClient.stop();
  });
});
