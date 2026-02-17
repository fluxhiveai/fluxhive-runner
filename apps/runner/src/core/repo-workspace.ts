import type { ConvexClient } from "convex/browser";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Task } from "./types.js";
import { resolveRepoWorkspaceDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveUserPath } from "../../utils.js";
import { api } from "./convex-client.js";

const execFileAsync = promisify(execFile);
const log = createSubsystemLogger("flux").child("repo-workspace");

type RepoContext = {
  runId?: string;
  integrationId?: string;
  owner?: string;
  repo?: string;
  repoPath?: string;
};

const syncLocks = new Map<string, Promise<void>>();
const lastSyncedAt = new Map<string, number>();
const lastSyncedAtCache = new Map<string, number>();

function parseTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function syncIntervalMs(): number {
  const raw = Number.parseInt(process.env.OPENCLAW_REPO_SYNC_INTERVAL_MS ?? "", 10);
  if (!Number.isFinite(raw) || raw < 0) {
    return 30_000;
  }
  return raw;
}

type RepoSyncSettings = {
  syncDisabled: boolean;
  minIntervalMs: number;
};

function parseSettingsMap(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) {
    return {};
  }
  const map: Record<string, string> = {};
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const key = parseTrimmedString(row.key);
    const settingValue = parseTrimmedString(row.value);
    if (!key || settingValue === undefined) {
      continue;
    }
    map[key] = settingValue;
  }
  return map;
}

function resolveRepoSyncSettingsFromIntegration(integration: unknown): RepoSyncSettings | null {
  if (!integration || typeof integration !== "object" || Array.isArray(integration)) {
    return null;
  }
  const row = integration as Record<string, unknown>;
  const type = parseTrimmedString(row.type);
  if (type !== "github") {
    return null;
  }
  const settings = parseSettingsMap(row.settings);
  const rawDisabled = parseTrimmedString(settings.repoAutoSync ?? settings.repo_auto_sync);
  const syncDisabled =
    rawDisabled === "0" || rawDisabled?.toLowerCase() === "false"
      ? true
      : process.env.OPENCLAW_REPO_AUTO_SYNC?.trim() === "0";

  const intervalMs =
    parseOptionalInteger(settings.repoSyncIntervalMs ?? settings.repo_sync_interval_ms) ??
    (() => {
      const seconds = parseOptionalInteger(
        settings.repoSyncIntervalSeconds ?? settings.repo_sync_interval_seconds,
      );
      return seconds !== undefined ? seconds * 1000 : undefined;
    })();
  const minIntervalMs = intervalMs !== undefined ? intervalMs : syncIntervalMs();
  return { syncDisabled, minIntervalMs };
}

function repoSyncKvKey(owner: string, repo: string): { namespace: string; key: string } {
  return { namespace: "repo_sync", key: `managed_workspace:${owner}/${repo}` };
}

async function readPersistedLastSyncedAtMs(args: {
  client: ConvexClient;
  task: Task;
  owner: string;
  repo: string;
}): Promise<number | undefined> {
  const slug = parseTrimmedString(args.task.workflow);
  if (!slug) {
    return undefined;
  }

  const cacheKey = `${args.task.streamId ?? "global"}:${slug}:${args.owner}/${args.repo}`;
  const cached = lastSyncedAtCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const playbook = (await args.client.query(api.playbooks.getBySlug, {
    slug,
    ...(args.task.streamId ? { streamId: args.task.streamId } : {}),
  })) as { _id: string } | null;
  if (!playbook?._id) {
    return undefined;
  }

  // Use memory_kv for sync timestamp storage
  const { namespace, key } = repoSyncKvKey(args.owner, args.repo);
  const row = (await args.client.query(api.memory_kv.get, {
    scope: "global",
    scopeId: "system",
    namespace,
    key,
  })) as { valueJson?: string } | null;
  if (!row?.valueJson) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(row.valueJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const obj = parsed as Record<string, unknown>;
    const value = obj.lastSyncedAtMs;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      lastSyncedAtCache.set(cacheKey, value);
      return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function writePersistedLastSyncedAtMs(args: {
  client: ConvexClient;
  task: Task;
  owner: string;
  repo: string;
  syncedAtMs: number;
}): Promise<void> {
  const { namespace, key } = repoSyncKvKey(args.owner, args.repo);
  await args.client.mutation(api.memory_kv.upsert, {
    scope: "global",
    scopeId: "system",
    namespace,
    key,
    valueJson: JSON.stringify({ lastSyncedAtMs: args.syncedAtMs }),
    source: "system",
    updatedBy: "repo-workspace",
  });

  const slug = parseTrimmedString(args.task.workflow);
  const cacheKey = `${args.task.streamId ?? "global"}:${slug ?? ""}:${args.owner}/${args.repo}`;
  lastSyncedAtCache.set(cacheKey, args.syncedAtMs);
}

async function runGit(args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env },
  });
}

async function ensureManagedWorkspaceSynced(
  owner: string,
  repo: string,
  workspaceDir: string,
  opts?: {
    syncDisabled?: boolean;
    minIntervalMs?: number;
    previousSyncAtMs?: number;
    onSynced?: (syncedAtMs: number) => Promise<void> | void;
  },
): Promise<void> {
  const syncDisabled = opts?.syncDisabled ?? process.env.OPENCLAW_REPO_AUTO_SYNC?.trim() === "0";
  if (syncDisabled) {
    return;
  }

  const now = Date.now();
  const minIntervalMs = opts?.minIntervalMs ?? syncIntervalMs();
  const previousSyncAt = opts?.previousSyncAtMs ?? lastSyncedAt.get(workspaceDir) ?? 0;
  if (minIntervalMs > 0 && now - previousSyncAt < minIntervalMs) {
    return;
  }

  const existing = syncLocks.get(workspaceDir);
  if (existing) {
    await existing;
    return;
  }

  const syncPromise = (async () => {
    await fs.mkdir(path.dirname(workspaceDir), { recursive: true });
    const gitMarker = path.join(workspaceDir, ".git");
    const hasGitMarker = await pathExists(gitMarker);
    if (!hasGitMarker) {
      const hasWorkspace = await pathExists(workspaceDir);
      if (hasWorkspace) {
        const entries = await fs.readdir(workspaceDir);
        if (entries.length > 0) {
          throw new Error(
            `workspace exists but is not a git checkout (${workspaceDir}); set repoPath explicitly`,
          );
        }
      }
      const remote = `https://github.com/${owner}/${repo}.git`;
      await runGit(["clone", "--depth", "1", remote, workspaceDir]);
      const syncedAtMs = Date.now();
      lastSyncedAt.set(workspaceDir, syncedAtMs);
      await opts?.onSynced?.(syncedAtMs);
      return;
    }

    await runGit(["-C", workspaceDir, "fetch", "--prune", "origin"]);
    const syncedAtMs = Date.now();
    lastSyncedAt.set(workspaceDir, syncedAtMs);
    await opts?.onSynced?.(syncedAtMs);
  })();

  syncLocks.set(workspaceDir, syncPromise);
  try {
    await syncPromise;
  } finally {
    if (syncLocks.get(workspaceDir) === syncPromise) {
      syncLocks.delete(workspaceDir);
    }
  }
}

export async function resolveExecutionCwdFromRepoContext(
  context: RepoContext | null | undefined,
  syncOpts?: {
    syncDisabled?: boolean;
    minIntervalMs?: number;
    previousSyncAtMs?: number;
    onSynced?: (syncedAtMs: number) => Promise<void> | void;
  },
): Promise<string | undefined> {
  const explicitPath = parseTrimmedString(context?.repoPath);
  if (explicitPath) {
    return resolveUserPath(explicitPath);
  }

  const owner = parseTrimmedString(context?.owner);
  const repo = parseTrimmedString(context?.repo);
  if (!owner || !repo) {
    return undefined;
  }

  let workspaceDir: string;
  try {
    workspaceDir = resolveRepoWorkspaceDir(owner, repo);
  } catch (e: unknown) {
    log.warn(`invalid repo workspace owner/repo (${owner}/${repo}): ${String(e)}`);
    return undefined;
  }

  try {
    await ensureManagedWorkspaceSynced(owner, repo, workspaceDir, syncOpts);
  } catch (e: unknown) {
    const errorText = e instanceof Error ? e.message : String(e);
    log.warn(`repo workspace sync failed for ${owner}/${repo}: ${errorText}`);
  }

  return (await pathExists(workspaceDir)) ? workspaceDir : undefined;
}

export async function resolveExecutionCwdForTask(
  task: Task,
  client: ConvexClient,
): Promise<{ cwd?: string; repoContext?: RepoContext | null }> {
  try {
    const repoContext = (await client.query(api.tasks.getExecutionRepoContext, {
      taskId: task._id,
    })) as RepoContext | null;
    const owner = parseTrimmedString(repoContext?.owner);
    const repo = parseTrimmedString(repoContext?.repo);
    const integrationId = parseTrimmedString(repoContext?.integrationId);

    const explicitPath = parseTrimmedString(repoContext?.repoPath);
    let syncOpts:
      | {
          syncDisabled?: boolean;
          minIntervalMs?: number;
          previousSyncAtMs?: number;
          onSynced?: (syncedAtMs: number) => Promise<void> | void;
        }
      | undefined;
    if (!explicitPath && owner && repo && integrationId) {
      const integration = (await client.query(api.integrations.get, {
        id: integrationId,
      })) as unknown;
      const settings = resolveRepoSyncSettingsFromIntegration(integration);
      if (settings) {
        const previousSyncAtMs = await readPersistedLastSyncedAtMs({
          client,
          task,
          owner,
          repo,
        });
        syncOpts = {
          syncDisabled: settings.syncDisabled,
          minIntervalMs: settings.minIntervalMs,
          ...(previousSyncAtMs !== undefined ? { previousSyncAtMs } : {}),
          onSynced: async (syncedAtMs: number) => {
            await writePersistedLastSyncedAtMs({ client, task, owner, repo, syncedAtMs });
          },
        };
      }
    }

    const cwd = await resolveExecutionCwdFromRepoContext(repoContext, syncOpts);
    return { cwd, repoContext };
  } catch (e: unknown) {
    log.warn(`failed to resolve execution cwd for task ${task._id}: ${String(e)}`);
    return { cwd: undefined, repoContext: null };
  }
}
