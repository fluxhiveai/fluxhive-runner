import type { ConvexClient } from "convex/browser";
import { api } from "../core/convex-client.js";

type SkillLike = {
  _id: string;
  name: string;
  type?: string;
  enabled?: boolean;
  capableRoles?: string[];
};

type AgentLike = {
  _id: string;
  name: string;
  role?: string;
};

type TaskLike = {
  _id: string;
  status: "todo" | "doing" | "blocked" | "review" | "done" | "failed";
  output?: string;
};

type RuntimeHooks = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

const defaultRuntimeHooks: RuntimeHooks = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class SkillNotFoundError extends Error {
  constructor(skillName: string) {
    super(`Skill not found: ${skillName}`);
    this.name = "SkillNotFoundError";
  }
}

export class SkillDisabledError extends Error {
  constructor(skillName: string) {
    super(`Skill "${skillName}" is disabled`);
    this.name = "SkillDisabledError";
  }
}

export class AgentResolutionError extends Error {
  constructor(skillName: string) {
    super(`No eligible agent found for skill "${skillName}"`);
    this.name = "AgentResolutionError";
  }
}

export class TaskFailedError extends Error {
  constructor(taskId: string, output: string) {
    super(`Task failed (${taskId}): ${output.slice(0, 500)}`);
    this.name = "TaskFailedError";
  }
}

export class TaskTimeoutError extends Error {
  constructor(taskId: string, timeoutMs: number) {
    super(`Task timed out after ${timeoutMs}ms: ${taskId}`);
    this.name = "TaskTimeoutError";
  }
}

export type CreateAndAwaitTaskOptions = {
  client: ConvexClient;
  squadId: string;
  skillName: string;
  input: Record<string, unknown>;
  goal?: string;
  source?: string;
  rockId?: string;
  runId?: string;
  contextFrom?: string[];
  timeoutMs?: number;
  pollIntervalMs?: number;
  requireAgent?: boolean;
  hooks?: Partial<RuntimeHooks>;
};

export type CreateAndAwaitTaskResult = {
  taskId: string;
  status: "done" | "review";
  output: string;
};

function resolveAgentForSkill(skill: SkillLike, agents: AgentLike[]): AgentLike | undefined {
  const roles = skill.capableRoles ?? [];
  if (roles.length === 0) {
    return undefined;
  }

  return agents.find((agent) =>
    roles.some((role) => agent.name === role || agent.role?.includes(role)),
  );
}

export async function createAndAwaitTask(
  opts: CreateAndAwaitTaskOptions,
): Promise<CreateAndAwaitTaskResult> {
  const {
    client,
    squadId,
    skillName,
    input,
    goal,
    source = "run",
    rockId,
    runId,
    contextFrom,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    requireAgent = false,
    hooks,
  } = opts;

  const runtime: RuntimeHooks = { ...defaultRuntimeHooks, ...hooks };

  const skill = (await client.query(api.skills.getByName, { name: skillName })) as SkillLike | null;
  if (!skill || skill.type !== "execution") {
    throw new SkillNotFoundError(skillName);
  }
  if (skill.enabled === false) {
    throw new SkillDisabledError(skill.name);
  }

  const agents = (await client.query(api.agents.list, { squadId })) as AgentLike[];
  const matchedAgent = resolveAgentForSkill(skill, agents);
  if (requireAgent && !matchedAgent) {
    throw new AgentResolutionError(skill.name);
  }

  const taskId = (await client.mutation(api.tasks.create, {
    squadId,
    skillId: skill._id,
    type: skill.name,
    goal: goal?.trim() || `[Run] ${skill.name}`,
    input: JSON.stringify(input),
    source,
    agentId: matchedAgent?._id,
    ...(rockId !== undefined ? { rockId } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(contextFrom !== undefined ? { contextFrom } : {}),
  })) as string;

  const deadline = runtime.now() + timeoutMs;
  while (runtime.now() < deadline) {
    const task = (await client.query(api.tasks.get, { id: taskId })) as TaskLike | null;
    if (task?.status === "done" || task?.status === "review") {
      return {
        taskId,
        status: task.status,
        output: task.output ?? "",
      };
    }
    if (task?.status === "failed") {
      throw new TaskFailedError(taskId, task.output ?? "unknown error");
    }

    await runtime.sleep(pollIntervalMs);
  }

  throw new TaskTimeoutError(taskId, timeoutMs);
}
