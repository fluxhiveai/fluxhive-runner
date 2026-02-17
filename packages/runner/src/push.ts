import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { FluxMcpClient } from "./client.js";

type PushEvent = {
  type?: string;
  taskId?: string;
  streamId?: string;
  goal?: string;
  backend?: string;
  costClass?: string;
};

export type FluxPushClientOptions = {
  wsUrl: string;
  fluxClient: FluxMcpClient;
  reconnectBaseMs: number;
  runnerType: string;
  runnerVersion: string;
  runnerInstanceId: string;
  machineId: string;
  streamId?: string;
  backend?: string;
  costClass?: string;
};

export class FluxPushClient extends EventEmitter {
  private readonly opts: FluxPushClientOptions;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private closed = false;

  constructor(opts: FluxPushClientOptions) {
    super();
    this.opts = opts;
  }

  private clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.closed) {
      return;
    }
    const backoff = Math.min(
      30_000,
      Math.max(this.opts.reconnectBaseMs, this.opts.reconnectBaseMs * 2 ** this.reconnectAttempt),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, backoff);
  }

  private async buildSocketUrl(): Promise<string> {
    const ticket = await this.opts.fluxClient.mintPushTicket({
      wsUrl: this.opts.wsUrl,
      streamId: this.opts.streamId,
      backend: this.opts.backend,
      costClass: this.opts.costClass,
      runnerType: this.opts.runnerType,
      runnerVersion: this.opts.runnerVersion,
      runnerInstanceId: this.opts.runnerInstanceId,
      machineId: this.opts.machineId,
    });
    const url = new URL(this.opts.wsUrl);
    url.searchParams.set("ticket", ticket.ticket);
    return url.toString();
  }

  async connect(): Promise<void> {
    this.clearTimers();
    const wsUrl = await this.buildSocketUrl();
    const socket = new WebSocket(wsUrl, {
      handshakeTimeout: 10_000,
      maxPayload: 4 * 1024 * 1024,
    });
    this.ws = socket;

    socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.emit("connected");
      this.pingTimer = setInterval(() => {
        try {
          socket.send(JSON.stringify({ type: "ping" }));
        } catch {
          // close handler will reconnect.
        }
      }, 20_000);
    });
    socket.on("message", (raw) => {
      let payload: PushEvent | null = null;
      try {
        payload = JSON.parse(String(raw)) as PushEvent;
      } catch {
        return;
      }
      if (!payload) {
        return;
      }
      if (payload.type === "task.available") {
        this.emit("task.available", payload);
      }
    });
    socket.on("close", () => {
      this.clearTimers();
      this.emit("disconnected");
      this.scheduleReconnect();
    });
    socket.on("error", (error) => {
      this.emit("error", error);
      this.clearTimers();
      this.scheduleReconnect();
    });
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.connect();
  }

  stop() {
    this.closed = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
