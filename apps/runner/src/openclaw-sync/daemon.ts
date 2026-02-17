import { watch } from "chokidar";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../config/io.js";
import { resolveStateDir } from "../../config/paths.js";
import { createConvexClient } from "../core/convex-client.js";
import { fullSync, isWatchedFile, removeFileSync, syncSingleFile } from "./sync-fns.js";

async function main() {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    console.error("[openclaw-sync] CONVEX_URL is required");
    process.exit(1);
  }

  const token = process.env.OC_SYNC_TOKEN;
  if (!token) {
    console.error("[openclaw-sync] OC_SYNC_TOKEN is required");
    process.exit(1);
  }

  const machineId = os.hostname();
  const stateDir = resolveStateDir();
  const cfg = loadConfig();
  const client = createConvexClient(convexUrl);

  console.log(`[openclaw-sync] Machine: ${machineId}`);
  console.log(`[openclaw-sync] State dir: ${stateDir}`);
  console.log(`[openclaw-sync] Starting initial sync...`);

  const count = await fullSync(client, token, machineId, cfg, stateDir);
  console.log(`[openclaw-sync] Initial sync complete: ${count} files`);

  console.log(`[openclaw-sync] Watching ${stateDir} for changes...`);

  const watcher = watch(stateDir, {
    persistent: true,
    ignoreInitial: true,
    depth: 10,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on("add", (absPath: string) => {
    const relPath = path.relative(stateDir, absPath);
    if (isWatchedFile(relPath)) {
      console.log(`[openclaw-sync] File added: ${relPath}`);
      void syncSingleFile(client, token, machineId, absPath, stateDir, cfg);
    }
  });

  watcher.on("change", (absPath: string) => {
    const relPath = path.relative(stateDir, absPath);
    if (isWatchedFile(relPath)) {
      console.log(`[openclaw-sync] File changed: ${relPath}`);
      void syncSingleFile(client, token, machineId, absPath, stateDir, cfg);
    }
  });

  watcher.on("unlink", (absPath: string) => {
    const relPath = path.relative(stateDir, absPath);
    if (isWatchedFile(relPath)) {
      console.log(`[openclaw-sync] File removed: ${relPath}`);
      void removeFileSync(client, token, machineId, absPath, stateDir);
    }
  });

  watcher.on("error", (err: unknown) => {
    console.error("[openclaw-sync] Watcher error:", err);
  });

  // Keep process alive
  process.on("SIGINT", () => {
    console.log("\n[openclaw-sync] Shutting down...");
    void watcher.close().then(() => {
      void client.close();
      process.exit(0);
    });
  });

  process.on("SIGTERM", () => {
    void watcher.close().then(() => {
      void client.close();
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error("[openclaw-sync] Fatal error:", err);
  process.exit(1);
});
