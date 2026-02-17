import type { ConvexClient } from "convex/browser";
import type { RuntimeContext } from "../core/types.js";
import type { IntegrationIntakeAdapter, IntegrationRow } from "./integration-adapter.js";
import type { TaskSource } from "./source.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { api } from "../core/convex-client.js";

type IntegrationBackoff = {
  failures: number;
  backoffUntil: number;
};

const log = createSubsystemLogger("flux").child("integration-intake");

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolvePollConcurrency(input: number | undefined): number {
  if (typeof input === "number" && Number.isFinite(input) && input > 0) {
    return Math.floor(input);
  }
  return parsePositiveInt(process.env.OPENCLAW_INTAKE_POLL_CONCURRENCY, 4);
}

function resolvePollTimeoutMs(input: number | undefined): number {
  if (typeof input === "number" && Number.isFinite(input) && input > 0) {
    return Math.floor(input);
  }
  return parsePositiveInt(process.env.OPENCLAW_INTAKE_POLL_TIMEOUT_MS, 120_000);
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(onTimeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function createIntegrationIntakeWorker(
  client: ConvexClient,
  opts: {
    pollEveryMs?: number;
    pollConcurrency?: number;
    pollTimeoutMs?: number;
    adapters?: IntegrationIntakeAdapter[];
  } = {},
): TaskSource {
  let timer: ReturnType<typeof setInterval> | null = null;
  const backoff = new Map<string, IntegrationBackoff>();
  const pollEveryMs = opts.pollEveryMs ?? 60_000;
  const pollConcurrency = resolvePollConcurrency(opts.pollConcurrency);
  const pollTimeoutMs = resolvePollTimeoutMs(opts.pollTimeoutMs);
  const maxBackoffMs = 5 * 60_000;
  const adapters = opts.adapters ?? [];
  const adapterByType = new Map(adapters.map((adapter) => [adapter.type, adapter]));

  async function listEnabledIntegrations(): Promise<IntegrationRow[]> {
    const rows = (await client.query(api.integrations.list, {
      enabled: true,
    })) as IntegrationRow[];
    return rows.filter((row) => row.enabled);
  }

  function getBackoffState(integrationId: string): IntegrationBackoff {
    return (
      backoff.get(integrationId) ?? {
        failures: 0,
        backoffUntil: 0,
      }
    );
  }

  function setBackoffState(integrationId: string, state: IntegrationBackoff) {
    backoff.set(integrationId, state);
  }

  async function pollOneIntegration(
    integration: IntegrationRow,
    adapter: IntegrationIntakeAdapter,
  ) {
    const now = Date.now();
    const state = getBackoffState(integration._id);
    if (now < state.backoffUntil) {
      return;
    }

    try {
      await withTimeout(
        adapter.pollIntegration({ integration, client }),
        pollTimeoutMs,
        `integration ${integration._id} poll timed out after ${pollTimeoutMs}ms`,
      );
      setBackoffState(integration._id, { failures: 0, backoffUntil: 0 });
      await client.mutation(api.integrations.update, {
        id: integration._id,
        lastError: undefined,
        lastSyncedAt: Date.now(),
      });
    } catch (error: unknown) {
      const errorText = error instanceof Error ? error.message : String(error);
      const failures = state.failures + 1;
      const backoffMs = Math.min(maxBackoffMs, pollEveryMs * 2 ** (failures - 1));
      setBackoffState(integration._id, {
        failures,
        backoffUntil: Date.now() + backoffMs,
      });
      await client.mutation(api.integrations.update, {
        id: integration._id,
        lastError: errorText,
      });
      log.warn(
        `integration ${integration._id} poll failed (${failures}): ${errorText}; backoff ${Math.round(
          backoffMs / 1000,
        )}s`,
      );
    }
  }

  async function poll() {
    const integrations = await listEnabledIntegrations();
    if (integrations.length === 0) {
      return;
    }

    let nextIndex = 0;
    const workerCount = Math.min(pollConcurrency, integrations.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= integrations.length) {
            return;
          }
          const integration = integrations[index];
          if (!integration) {
            return;
          }
          const adapter = adapterByType.get(integration.type);
          if (!adapter) {
            log.debug(`no intake adapter registered for integration type "${integration.type}"`);
            continue;
          }
          await pollOneIntegration(integration, adapter);
        }
      }),
    );
  }

  return {
    id: "integration-intake",

    async start(_ctx: RuntimeContext) {
      if (adapters.length === 0) {
        log.warn(
          "integration intake worker started without adapters; no integrations will be polled",
        );
      }
      await poll();
      timer = setInterval(() => void poll(), pollEveryMs);
      log.info(`integration intake worker started (every ${Math.round(pollEveryMs / 1000)}s)`);
    },

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      backoff.clear();
      for (const adapter of adapters) {
        if (adapter.stop) {
          await adapter.stop();
        }
      }
      log.info("integration intake worker stopped");
    },
  };
}
