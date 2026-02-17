import type { FluxMcpClient } from "./client.js";
import { TaskExecutor } from "./executor.js";

export type CadenceLoopOptions = {
  client: FluxMcpClient;
  executor: TaskExecutor;
  intervalMs: number;
  listLimit?: number;
  streamId?: string;
  backend?: string;
  costClass?: string;
  onError?: (error: unknown) => void;
};

export class CadenceLoop {
  private readonly opts: CadenceLoopOptions;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private tickInFlight: Promise<void> | null = null;
  private rerunRequested = false;

  constructor(opts: CadenceLoopOptions) {
    this.opts = opts;
  }

  private async drainOnce(): Promise<void> {
    const limit = Math.max(1, this.opts.listLimit ?? 10);
    while (this.running) {
      const page = await this.opts.client.listTasks({
        status: "todo",
        limit,
        mode: "compact",
        format: "packet",
        streamId: this.opts.streamId,
        backend: this.opts.backend,
        costClass: this.opts.costClass,
      });
      const tasks = Array.isArray(page.tasks) ? page.tasks : [];
      if (tasks.length === 0) {
        return;
      }
      for (const task of tasks) {
        await this.opts.executor.claimAndExecuteFromPacket(task);
      }
      if (tasks.length < limit) {
        return;
      }
    }
  }

  private async runTick() {
    if (!this.running) {
      return;
    }
    if (this.tickInFlight) {
      this.rerunRequested = true;
      return;
    }
    this.tickInFlight = (async () => {
      try {
        await this.drainOnce();
      } catch (error) {
        this.opts.onError?.(error);
      }
    })();

    try {
      await this.tickInFlight;
    } finally {
      this.tickInFlight = null;
      if (this.rerunRequested && this.running) {
        this.rerunRequested = false;
        void this.runTick();
      }
    }
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.runTick();
    this.intervalTimer = setInterval(() => {
      void this.runTick();
    }, Math.max(1_000, this.opts.intervalMs));
  }

  stop() {
    this.running = false;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  triggerNow() {
    if (!this.running) {
      return;
    }
    void this.runTick();
  }
}
