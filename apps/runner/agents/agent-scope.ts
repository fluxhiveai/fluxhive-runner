import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";

export function listAgentIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>(["main"]);
  for (const agent of cfg.agents ?? []) {
    if (typeof agent?.id === "string" && agent.id.trim().length > 0) {
      ids.add(agent.id.trim());
    }
  }
  return [...ids];
}

export function resolveAgentWorkspaceDir(cfg: OpenClawConfig, agentId: string): string {
  const match = (cfg.agents ?? []).find((agent) => agent.id === agentId);
  if (match?.workspaceDir && match.workspaceDir.trim().length > 0) {
    return path.resolve(match.workspaceDir);
  }
  const stateDir = resolveStateDir();
  if (agentId === "main") {
    return path.join(stateDir, "workspace");
  }
  return path.join(stateDir, `workspace-${agentId}`);
}
