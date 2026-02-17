// Cadence Scheduler — evaluates per-stream cadences on the heartbeat.
// Checks stream.cadenceConfigJson and triggers playbook runs when cadences are due.

import type { ConvexClient } from "convex/browser";
import type { Cadence, CadenceUnit } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { api } from "./convex-client.js";

const log = createSubsystemLogger("flux").child("cadence-scheduler");

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 604_800_000;
const MS_PER_MONTH = 2_592_000_000;

function cadenceToMs(cadence: Cadence): number {
  const { every, unit } = cadence;
  switch (unit) {
    case "minutes":
      return every * MS_PER_MINUTE;
    case "hours":
      return every * MS_PER_HOUR;
    case "days":
      return every * MS_PER_DAY;
    case "weeks":
      return every * MS_PER_WEEK;
    case "months":
      return every * MS_PER_MONTH;
  }
}

export function isCadenceDue(now: Date, lastRun: Date | null, cadence: Cadence): boolean {
  if (!lastRun) {
    return true;
  }
  const ms = cadenceToMs(cadence);
  return now.getTime() - lastRun.getTime() >= ms;
}

type StreamRow = {
  _id: string;
  title: string;
  cadenceConfigJson?: string;
  status: string;
};

type CadenceEntry = {
  name: string;
  playbookSlug: string;
  enabled?: boolean;
  schedule?: {
    every?: number;
    unit?: CadenceUnit;
  };
};

function parseCadenceConfig(raw: string | undefined): CadenceEntry[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is CadenceEntry =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).name === "string" &&
        typeof (entry as Record<string, unknown>).playbookSlug === "string",
    );
  } catch {
    return [];
  }
}

function cadenceFromEntry(entry: CadenceEntry): Cadence | undefined {
  const every = entry.schedule?.every;
  const unit = entry.schedule?.unit;
  if (typeof every !== "number" || !Number.isFinite(every) || every <= 0 || !unit) {
    return undefined;
  }
  return { every, unit };
}

function lastRunKvKey(cadenceName: string): { namespace: string; key: string } {
  return { namespace: "_cadence", key: `${cadenceName}:lastRun` };
}

async function getLastRunFromMemory(
  client: ConvexClient,
  streamId: string,
  cadenceName: string,
): Promise<Date | null> {
  try {
    const { namespace, key } = lastRunKvKey(cadenceName);
    const row = (await client.query(api.memory_kv.get, {
      scope: "stream",
      scopeId: streamId,
      namespace,
      key,
    })) as { valueJson?: string } | null;
    if (!row?.valueJson) {
      return null;
    }
    const parsed = JSON.parse(row.valueJson) as unknown;
    if (typeof parsed === "string") {
      const date = new Date(parsed);
      return Number.isFinite(date.getTime()) ? date : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function setLastRunInMemory(
  client: ConvexClient,
  streamId: string,
  cadenceName: string,
  now: Date,
): Promise<void> {
  try {
    const { namespace, key } = lastRunKvKey(cadenceName);
    await client.mutation(api.memory_kv.upsert, {
      scope: "stream",
      scopeId: streamId,
      namespace,
      key,
      valueJson: JSON.stringify(now.toISOString()),
      source: "cadence-scheduler",
      updatedBy: "system",
    });
  } catch (e: unknown) {
    log.warn(`failed to update cadence last-run for ${cadenceName}: ${String(e)}`);
  }
}

async function checkStreamCadences(client: ConvexClient, stream: StreamRow): Promise<void> {
  const entries = parseCadenceConfig(stream.cadenceConfigJson);
  if (entries.length === 0) {
    return;
  }

  const now = new Date();

  for (const entry of entries) {
    if (entry.enabled === false) {
      continue;
    }

    const cadence = cadenceFromEntry(entry);
    if (!cadence) {
      log.debug(`stream ${stream._id} cadence "${entry.name}" has no valid schedule`);
      continue;
    }

    try {
      const lastRun = await getLastRunFromMemory(client, stream._id, entry.name);
      if (!isCadenceDue(now, lastRun, cadence)) {
        continue;
      }

      log.info(
        `cadence "${entry.name}" due for stream "${stream.title}" (${stream._id}) — starting playbook ${entry.playbookSlug}`,
      );

      // Look up the playbook (stream-scoped first, then global)
      const playbook = (await client.query(api.playbooks.getBySlug, {
        slug: entry.playbookSlug,
        streamId: stream._id,
      })) as { _id: string; status: string } | null;

      if (!playbook || playbook.status !== "active") {
        log.debug(
          `cadence "${entry.name}": playbook "${entry.playbookSlug}" not found or not active for stream ${stream._id}`,
        );
        continue;
      }

      // Start playbook run
      const threadId = `cadence:${stream._id}:${entry.name}:${now.getTime()}`;
      await client.mutation(api.runs.create, {
        streamId: stream._id,
        playbookId: playbook._id,
        name: `${entry.name} (cadence)`,
        threadId,
        paramsJson: JSON.stringify({
          cadenceName: entry.name,
          source: "cadence-scheduler",
        }),
      });

      await setLastRunInMemory(client, stream._id, entry.name, now);
    } catch (e: unknown) {
      log.warn(`cadence "${entry.name}" check failed for stream ${stream._id}: ${String(e)}`);
    }
  }
}

/** Also check playbook_triggers (cron type) for backward compatibility. */
async function checkPlaybookTriggers(client: ConvexClient): Promise<void> {
  const triggers = (await client.query(api.playbook_triggers.getEnabledCrons, {})) as Array<{
    _id: string;
    playbookId: string;
    streamId?: string;
    configJson?: string;
  }>;

  for (const trigger of triggers) {
    try {
      const playbook = (await client.query(api.playbooks.get, {
        id: trigger.playbookId,
      })) as { _id: string; slug: string; status: string } | null;
      if (!playbook || playbook.status !== "active") {
        continue;
      }

      // Parse schedule from configJson
      let schedule: { every?: number; unit?: CadenceUnit } | undefined;
      if (trigger.configJson) {
        try {
          const config = JSON.parse(trigger.configJson) as Record<string, unknown>;
          schedule =
            config.schedule && typeof config.schedule === "object"
              ? (config.schedule as { every?: number; unit?: CadenceUnit })
              : undefined;
        } catch {
          continue;
        }
      }

      if (
        !schedule ||
        typeof schedule.every !== "number" ||
        !Number.isFinite(schedule.every) ||
        schedule.every <= 0 ||
        !schedule.unit
      ) {
        continue;
      }

      const cadence: Cadence = { every: schedule.every, unit: schedule.unit };

      // Check last run via admin KV (backward compat)
      const lastRunKey = `last_playbook_trigger_run:${trigger._id}`;
      const lastRunRaw = (await client.query(api.admin.getValue, {
        key: lastRunKey,
      })) as string | null;
      const lastRun = lastRunRaw ? new Date(lastRunRaw) : null;
      const now = new Date();

      if (!isCadenceDue(now, lastRun, cadence)) {
        continue;
      }

      log.info(`playbook trigger ${trigger._id} due — starting run for playbook ${playbook.slug}`);

      const threadId = `trigger:${trigger._id}:scheduled:${now.getTime()}`;
      await client.mutation(api.runs.create, {
        streamId: trigger.streamId,
        playbookId: playbook._id,
        name: `${playbook.slug} (trigger)`,
        threadId,
        paramsJson: JSON.stringify({
          triggerId: trigger._id,
          source: "cadence-scheduler",
        }),
      });

      await client.mutation(api.admin.setValue, {
        key: lastRunKey,
        value: now.toISOString(),
      });
    } catch (e: unknown) {
      log.warn(`playbook trigger ${trigger._id} check failed: ${String(e)}`);
    }
  }
}

/** Main entry point — called on each heartbeat. */
export async function checkCadences(client: ConvexClient): Promise<void> {
  // 1. Check per-stream cadences
  const streams = (await client.query(api.streams.list, {
    status: "active",
  })) as StreamRow[];

  for (const stream of streams) {
    try {
      await checkStreamCadences(client, stream);
    } catch (e: unknown) {
      log.warn(`cadence check failed for stream ${stream._id}: ${String(e)}`);
    }
  }

  // 2. Check legacy playbook_triggers (cron type)
  try {
    await checkPlaybookTriggers(client);
  } catch (e: unknown) {
    log.warn(`playbook trigger check failed: ${String(e)}`);
  }
}
