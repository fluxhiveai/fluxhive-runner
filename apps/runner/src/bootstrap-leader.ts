import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { listAgentEntries } from "../commands/agents.config.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveCliBin } from "./core/agent-spawn.js";
import { api, createConvexClient, type ConvexClient } from "./core/convex-client.js";

type SquadDoc = {
  _id: string;
  name: string;
  slug: string;
  description?: string;
  leaderAgentId?: string;
};

type AgentDoc = {
  _id: string;
  name: string;
  role?: string;
  creature?: string;
  vibe?: string;
  emoji?: string;
};

export type BootstrapLeaderOptions = {
  squadSlug: string;
  openclawAgentId?: string;
  workspaceDir?: string;
  createAgent?: boolean;
  client?: ConvexClient;
};

export type BootstrapLeaderResult = {
  squadId: string;
  squadSlug: string;
  leaderName: string;
  openclawAgentId: string;
  agentDir: string;
  createdAgent: boolean;
  writtenFiles: string[];
};

type TemplateOutput = {
  source: string;
  target: string;
};

const TEMPLATE_OUTPUTS: TemplateOutput[] = [
  { source: "leader-soul.md", target: "SOUL.md" },
  { source: "leader-identity.md", target: "IDENTITY.md" },
  { source: "leader-tools.md", target: "TOOLS.md" },
  { source: "leader-agents.md", target: "AGENTS.md" },
  { source: "leader-user.md", target: "USER.md" },
  { source: "leader-memory.md", target: path.join("memory", "MEMORY.md") },
];

function formatDateIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function deriveDomainLabel(squad: SquadDoc): string {
  return squad.slug.replace(/-/g, " ");
}

function formatAgentList(agents: AgentDoc[], leaderId?: string): string {
  const workers = agents.filter((agent) => agent._id !== leaderId);
  if (workers.length === 0) {
    return "- No worker agents yet";
  }
  return workers.map((agent) => `- ${agent.name}${agent.role ? `: ${agent.role}` : ""}`).join("\n");
}

function replaceTemplateVariables(source: string, vars: Record<string, string>): string {
  let output = source;
  for (const [key, value] of Object.entries(vars)) {
    output = output.replaceAll(`{${key}}`, value);
  }
  return output;
}

async function resolveTemplateDir(): Promise<string> {
  const root =
    (await resolveOpenClawPackageRoot({
      cwd: process.cwd(),
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
    })) ?? process.cwd();
  return path.join(root, "src", "squad", "templates");
}

async function ensureOpenClawAgentConfigured(
  openclawAgentId: string,
  workspaceDir: string,
): Promise<boolean> {
  const cfgSnapshot = await readConfigFileSnapshot();
  if (cfgSnapshot.valid) {
    const existing = listAgentEntries(cfgSnapshot.config).some(
      (entry) => normalizeAgentId(entry.id) === openclawAgentId,
    );
    if (existing) {
      return false;
    }
  }

  const bin = resolveCliBin();
  const args = [
    ...bin.prefixArgs,
    "agents",
    "add",
    "--name",
    openclawAgentId,
    "--workspace",
    workspaceDir,
    "--non-interactive",
  ];
  const result = spawnSync(bin.command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(
      `Failed to create OpenClaw agent "${openclawAgentId}" (exit ${String(result.status)}). ${stderr || stdout || "No output"}`,
    );
  }
  return true;
}

async function resolveAgentDirFromConfig(openclawAgentId: string): Promise<string> {
  const cfgSnapshot = await readConfigFileSnapshot();
  if (!cfgSnapshot.valid) {
    const details = cfgSnapshot.issues.map((issue) => issue.message).join("; ");
    throw new Error(`OpenClaw config invalid${details ? `: ${details}` : ""}`);
  }
  return resolveAgentDir(cfgSnapshot.config, openclawAgentId);
}

export async function bootstrapLeaderAgent(
  options: BootstrapLeaderOptions,
): Promise<BootstrapLeaderResult> {
  const squadSlug = options.squadSlug.trim();
  if (!squadSlug) {
    throw new Error("squadSlug is required");
  }

  const ownsClient = !options.client;
  const client = options.client ?? createConvexClient();
  try {
    const squad = (await client.query(api.squads.getBySlug, {
      slug: squadSlug,
    })) as SquadDoc | null;
    if (!squad) {
      throw new Error(`Squad "${squadSlug}" not found`);
    }

    const agents = (await client.query(api.agents.list, { squadId: squad._id })) as AgentDoc[];
    const leader =
      agents.find((agent) => agent._id === squad.leaderAgentId) ??
      agents.find((agent) => agent.role?.toLowerCase().includes("leader"));
    const leaderName = leader?.name ?? "NEXUS";
    const openclawAgentId = normalizeAgentId(options.openclawAgentId ?? `${squad.slug}-leader`);
    const workspaceDir = options.workspaceDir?.trim() || process.cwd();

    let createdAgent = false;
    if (options.createAgent !== false) {
      createdAgent = await ensureOpenClawAgentConfigured(openclawAgentId, workspaceDir);
    }

    const templateDir = await resolveTemplateDir();
    const agentDir = await resolveAgentDirFromConfig(openclawAgentId);
    const vars: Record<string, string> = {
      LEADER_NAME: leaderName,
      SQUAD_NAME: squad.name,
      SQUAD_SLUG: squad.slug,
      SQUAD_ID: squad._id,
      SQUAD_PURPOSE: squad.description?.trim() || `${squad.name} executes strategic goals.`,
      SQUAD_DOMAIN: deriveDomainLabel(squad),
      LEADER_CREATURE: leader?.creature ?? "Octopus",
      LEADER_VIBE: leader?.vibe ?? "calm, decisive, systems-minded",
      LEADER_EMOJI: leader?.emoji ?? ":compass:",
      LEADER_CATCHPHRASE: "Here is the decision and what happens next.",
      BOOTSTRAP_DATE: formatDateIso(new Date()),
      AGENT_LIST: formatAgentList(agents, leader?._id),
    };

    const writtenFiles: string[] = [];
    for (const mapping of TEMPLATE_OUTPUTS) {
      const sourcePath = path.join(templateDir, mapping.source);
      const targetPath = path.join(agentDir, mapping.target);
      const template = await fs.readFile(sourcePath, "utf-8");
      const rendered = replaceTemplateVariables(template, vars);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, rendered, "utf-8");
      writtenFiles.push(targetPath);
    }

    if (leader?._id) {
      await client.mutation(api.agents.update, {
        id: leader._id,
        openclawAgentId,
      });
    }
    await client.mutation(api.squads.updateLeaderRuntime, {
      id: squad._id,
      leaderStatus: "active",
      leaderAgentId: squad.leaderAgentId ?? leader?._id ?? leaderName,
    });

    return {
      squadId: squad._id,
      squadSlug: squad.slug,
      leaderName,
      openclawAgentId,
      agentDir,
      createdAgent,
      writtenFiles,
    };
  } finally {
    if (ownsClient) {
      await client.close();
    }
  }
}
