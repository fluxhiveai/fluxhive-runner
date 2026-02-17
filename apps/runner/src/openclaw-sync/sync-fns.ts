import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { api } from "../core/convex-client.js";

const MAX_CONTENT_BYTES = 900 * 1024; // 900KB

type SyncApi = {
  syncFile: FunctionReference<"mutation">;
  removeFile: FunctionReference<"mutation">;
};

function getSyncApi(): SyncApi {
  return {
    syncFile: api.openclaw.syncFile,
    removeFile: api.openclaw.removeFile,
  };
}

export function resolveAgentIdFromPath(relPath: string, _cfg: OpenClawConfig): string {
  // workspace-{id}/... → "{id}"
  const workspaceSuffix = relPath.match(/^workspace-([^/]+)\//);
  if (workspaceSuffix) {
    return workspaceSuffix[1];
  }

  // workspace/... → "main" (default agent)
  if (relPath.startsWith("workspace/")) {
    return "main";
  }

  // Global files: cron/jobs.json, openclaw.json, etc.
  if (
    relPath.startsWith("cron/") ||
    relPath === "openclaw.json" ||
    relPath.startsWith("credentials/")
  ) {
    return "_global";
  }

  return "_global";
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function readFileContent(absPath: string): Promise<{
  content: string;
  sizeBytes: number;
  truncated: boolean;
}> {
  const stat = await fs.stat(absPath);
  const sizeBytes = stat.size;

  if (sizeBytes > MAX_CONTENT_BYTES) {
    // Read the last MAX_CONTENT_BYTES (tail)
    const fd = await fs.open(absPath, "r");
    try {
      const buf = Buffer.alloc(MAX_CONTENT_BYTES);
      const offset = sizeBytes - MAX_CONTENT_BYTES;
      await fd.read(buf, 0, MAX_CONTENT_BYTES, offset);
      return {
        content: buf.toString("utf-8"),
        sizeBytes,
        truncated: true,
      };
    } finally {
      await fd.close();
    }
  }

  const content = await fs.readFile(absPath, "utf-8");
  return { content, sizeBytes, truncated: false };
}

export async function syncSingleFile(
  client: ConvexClient,
  token: string,
  machineId: string,
  absPath: string,
  stateDir: string,
  cfg: OpenClawConfig,
): Promise<void> {
  const relPath = path.relative(stateDir, absPath);
  if (relPath.startsWith("..")) {
    return;
  }

  const agentId = resolveAgentIdFromPath(relPath, cfg);

  try {
    const { content, sizeBytes, truncated } = await readFileContent(absPath);
    const fileHash = hashContent(content);

    await client.mutation(getSyncApi().syncFile, {
      token,
      machineId,
      agentId,
      filePath: relPath,
      content,
      fileHash,
      sizeBytes,
      truncated,
    });
  } catch (err) {
    console.error(`[openclaw-sync] Failed to sync ${relPath}:`, err);
  }
}

export async function removeFileSync(
  client: ConvexClient,
  token: string,
  machineId: string,
  absPath: string,
  stateDir: string,
): Promise<void> {
  const relPath = path.relative(stateDir, absPath);
  if (relPath.startsWith("..")) {
    return;
  }

  try {
    await client.mutation(getSyncApi().removeFile, {
      token,
      machineId,
      filePath: relPath,
    });
  } catch (err) {
    console.error(`[openclaw-sync] Failed to remove ${relPath}:`, err);
  }
}

async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walkDir(full)));
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  } catch {
    // directory may not exist
  }
  return files;
}

function isWatchedFile(relPath: string): boolean {
  // all workspace files
  if (/^workspace(-[^/]+)?\//.test(relPath)) {
    return true;
  }
  // cron
  if (relPath === "cron/jobs.json") {
    return true;
  }
  // config
  if (relPath === "openclaw.json") {
    return true;
  }
  return false;
}

export async function fullSync(
  client: ConvexClient,
  token: string,
  machineId: string,
  cfg: OpenClawConfig,
  stateDir: string,
): Promise<number> {
  let synced = 0;

  // Collect all files from watched directories
  const dirsToWalk: string[] = [];

  // Agent workspace directories
  const agentIds = listAgentIds(cfg);
  for (const agentId of agentIds) {
    const wsDir = resolveAgentWorkspaceDir(cfg, agentId);
    dirsToWalk.push(wsDir);
  }

  // Cron directory
  dirsToWalk.push(path.join(stateDir, "cron"));

  // Collect and sync files
  for (const dir of dirsToWalk) {
    const files = await walkDir(dir);
    for (const absPath of files) {
      const relPath = path.relative(stateDir, absPath);
      if (isWatchedFile(relPath)) {
        await syncSingleFile(client, token, machineId, absPath, stateDir, cfg);
        synced++;
      }
    }
  }

  // Sync config file directly
  const configPath = path.join(stateDir, "openclaw.json");
  try {
    await fs.access(configPath);
    await syncSingleFile(client, token, machineId, configPath, stateDir, cfg);
    synced++;
  } catch {
    // config file may not exist
  }

  return synced;
}

export { isWatchedFile };
