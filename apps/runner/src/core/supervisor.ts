// Supervisor — watches for ready tasks, dispatches agents, enforces guardrails.
// Respects WIP limits, review queue caps, and failure auto-pause.

import type { ConvexClient } from "convex/browser";
import type { Task } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { checkCadences } from "./cadence-scheduler.js";
import { api } from "./convex-client.js";
import { createDispatchContext, dispatchTask } from "./dispatcher.js";

const log = createSubsystemLogger("flux").child("supervisor");

export type SupervisorConfig = {
  heartbeatIntervalMs?: number;
  maxConcurrent?: number;
  maxPendingReview?: number;
  autoPauseAfterNFails?: number;
};

export type Supervisor = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Manually trigger a sweep of ready tasks (used by CLI and tests). */
  processReadyTasks: () => Promise<number>;
};

export function createSupervisor(client: ConvexClient, opts: SupervisorConfig = {}): Supervisor {
  // Per-instance dispatch state (no module-level singletons)
  const dispatchCtx = createDispatchContext();

  // Per-instance failure log for auto-pause (rolling 30 min window)
  const failureLog: Array<{ type: string; time: number }> = [];
  const MAX_FAILURE_LOG_ENTRIES = 5_000;

  function countRecentFailures(agentType: string, windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return failureLog.filter((f) => f.type === agentType && f.time > cutoff).length;
  }

  function recordFailure(agentType: string) {
    failureLog.push({ type: agentType, time: Date.now() });
    const cutoff = Date.now() - 30 * 60_000;
    while (failureLog.length > 0 && failureLog[0].time < cutoff) {
      failureLog.shift();
    }
    while (failureLog.length > MAX_FAILURE_LOG_ENTRIES) {
      failureLog.shift();
    }
  }

  const heartbeatMs = opts.heartbeatIntervalMs ?? 60_000;
  const maxConcurrent = opts.maxConcurrent ?? (Number(process.env.SQUAD_MAX_CONCURRENT) || 4);
  const maxPendingReview =
    opts.maxPendingReview ?? (Number(process.env.SQUAD_MAX_PENDING_REVIEW) || 5);
  const autoPauseThreshold =
    opts.autoPauseAfterNFails ?? (Number(process.env.SQUAD_AUTO_PAUSE_AFTER_N_FAILS) || 5);

  let unsubscribe: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let paused = false;
  let pauseReason = "";
  let dispatching = false;
  let pendingRecheck = false;
  let heartbeatRunning = false;

  async function touchSupervisorHeartbeat() {
    try {
      await client.mutation(api.admin.setValue, {
        key: "supervisorHeartbeat",
        value: String(Date.now()),
      });
    } catch (e: unknown) {
      log.warn(`failed to write supervisor heartbeat: ${String(e)}`);
    }
  }

  async function onReadyTasks(tasks: Task[]) {
    if (!running || paused) {
      return;
    }
    if (dispatching) {
      pendingRecheck = true;
      return;
    }
    if (tasks.length === 0) {
      return;
    }

    dispatching = true;
    pendingRecheck = false;

    try {
      const counts = (await client.query(api.tasks.countByStatus, {})) as Record<string, number>;
      const reviewCount = counts.review ?? 0;
      const doingCount = counts.doing ?? 0;
      const todoCount = counts.todo ?? 0;

      log.info(
        `queue: ${todoCount} todo, ${doingCount} doing, ${reviewCount} review — ${tasks.length} ready`,
      );

      if (reviewCount >= maxPendingReview) {
        log.warn(
          `review queue full (${reviewCount}/${maxPendingReview}) — pausing until reviews are cleared`,
        );
        paused = true;
        pauseReason = `review queue full (${reviewCount} pending)`;
        return;
      }

      for (const task of tasks) {
        if (!running || paused) {
          break;
        }

        if (dispatchCtx.pendingDispatch.has(task._id) || dispatchCtx.activeSessions.has(task._id)) {
          continue;
        }

        if (dispatchCtx.activeSessions.size >= maxConcurrent) {
          log.info(
            `WIP full (${dispatchCtx.activeSessions.size}/${maxConcurrent}), waiting for capacity`,
          );
          break;
        }

        const recentFails = countRecentFailures(task.type, 30 * 60_000);
        if (recentFails >= autoPauseThreshold) {
          log.error(`auto-pause: ${task.type} has ${recentFails} failures in 30 min`);
          paused = true;
          pauseReason = `${task.type}: ${recentFails} failures in 30 min`;
          break;
        }

        log.info(`dispatching [${task.type}] ${task.goal} (${task._id})`);
        try {
          const result = await dispatchTask(task, client, dispatchCtx);
          result.promise
            .then(async ({ ok }) => {
              if (!ok) {
                recordFailure(task.type);
              }
              if (running && !paused) {
                const ready = (await client.query(api.tasks.getReady, {})) as Task[];
                if (ready.length > 0) {
                  void onReadyTasks(ready);
                }
              }
            })
            .catch((e: unknown) => {
              log.error(`dispatch promise error: ${String(e)}`);
              recordFailure(task.type);
            });
        } catch (e: unknown) {
          log.error(`failed to dispatch task ${task._id}: ${String(e)}`);
          recordFailure(task.type);
        }
      }
    } finally {
      dispatching = false;
      if (pendingRecheck && running && !paused) {
        pendingRecheck = false;
        try {
          const ready = (await client.query(api.tasks.getReady, {})) as Task[];
          if (ready.length > 0) {
            void onReadyTasks(ready);
          }
        } catch (e: unknown) {
          log.warn(`re-check query failed: ${String(e)}`);
        }
      }
    }
  }

  async function heartbeatCheck() {
    if (heartbeatRunning) {
      return;
    }
    heartbeatRunning = true;
    try {
      await touchSupervisorHeartbeat();

      const active = dispatchCtx.activeSessions.size;
      if (active > 0) {
        log.debug(`heartbeat: ${active} active session(s)`);
      }

      // Evaluate per-stream cadences and playbook triggers
      try {
        await checkCadences(client);
      } catch (e: unknown) {
        log.warn(`cadence check failed: ${String(e)}`);
      }

      // Auto-resume if paused due to review queue and reviews have been cleared
      if (paused && pauseReason.startsWith("review queue full")) {
        const counts = (await client.query(api.tasks.countByStatus, {})) as Record<string, number>;
        const reviewCount = counts.review ?? 0;
        if (reviewCount < maxPendingReview) {
          log.info(`review queue cleared (${reviewCount}/${maxPendingReview}) — resuming`);
          paused = false;
          pauseReason = "";
        }
      }
    } finally {
      heartbeatRunning = false;
    }
  }

  async function start() {
    if (running) {
      return;
    }
    running = true;
    paused = false;
    pauseReason = "";

    log.info(
      `supervisor starting (WIP: ${maxConcurrent}, review cap: ${maxPendingReview}, auto-pause after ${autoPauseThreshold} fails)`,
    );

    await touchSupervisorHeartbeat();

    // Subscribe to ready tasks — Convex pushes updates reactively (global)
    unsubscribe = client.onUpdate(api.tasks.getReady, {}, (tasks) => void onReadyTasks(tasks));

    // Periodic heartbeat + cadence checks + auto-resume
    heartbeatTimer = setInterval(() => void heartbeatCheck(), heartbeatMs);

    log.info("supervisor ready — watching for tasks");
  }

  async function stop() {
    if (!running) {
      return;
    }
    running = false;

    log.info("supervisor stopping");

    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    try {
      await client.mutation(api.admin.setValue, {
        key: "supervisorHeartbeat",
        value: "0",
      });
    } catch (e: unknown) {
      log.warn(`failed to clear supervisor heartbeat: ${String(e)}`);
    }

    const sessions = dispatchCtx.activeSessions;
    if (sessions.size > 0) {
      log.info(`killing ${sessions.size} active session(s)`);
      for (const [, session] of sessions) {
        session.kill();
      }
    }

    log.info("supervisor stopped");
  }

  async function processReadyTasks(): Promise<number> {
    const ready = (await client.query(api.tasks.getReady, {})) as Task[];
    if (ready.length === 0) {
      return 0;
    }

    const totalActive = dispatchCtx.activeSessions.size;
    const available = maxConcurrent - totalActive;
    if (available <= 0) {
      log.info(
        `processReadyTasks: WIP full (${totalActive}/${maxConcurrent}), skipping ${ready.length} ready tasks`,
      );
      return 0;
    }

    let dispatched = 0;
    for (const task of ready) {
      if (dispatched >= available) {
        break;
      }

      if (dispatchCtx.pendingDispatch.has(task._id) || dispatchCtx.activeSessions.has(task._id)) {
        continue;
      }

      log.info(
        `processReadyTasks: dispatching [${task.type}] ${task.goal} (${task._id}) via dispatcher`,
      );
      try {
        const result = await dispatchTask(task, client, dispatchCtx);
        dispatched++;
        result.promise
          .then(async ({ ok }) => {
            if (!ok) {
              recordFailure(task.type);
            }
          })
          .catch((e: unknown) => {
            log.error(`processReadyTasks: dispatch promise error: ${String(e)}`);
            recordFailure(task.type);
          });
      } catch (e: unknown) {
        log.error(`processReadyTasks: failed to dispatch task ${task._id}: ${String(e)}`);
        recordFailure(task.type);
      }
    }

    log.info(`processReadyTasks: dispatched ${dispatched} task(s)`);
    return dispatched;
  }

  return { start, stop, processReadyTasks };
}
