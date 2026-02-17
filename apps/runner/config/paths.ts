import os from "node:os";
import path from "node:path";

export function resolveStateDir(): string {
  const configured = process.env.OPENCLAW_STATE_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".openclaw");
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function resolveRepoWorkspaceDir(owner: string, repo: string): string {
  if (!owner.trim() || !repo.trim()) {
    throw new Error("owner and repo are required");
  }
  const root =
    process.env.OPENCLAW_REPO_WORKSPACE_ROOT?.trim() ||
    path.join(resolveStateDir(), "repos");
  return path.join(root, sanitizePathPart(owner), sanitizePathPart(repo));
}
