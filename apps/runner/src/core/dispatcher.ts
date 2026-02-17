// Dispatcher — spawns openclaw agent subprocess for each task.
// Uses child_process to run the agent in isolation, tracks sessions in Convex.

import type { ConvexClient } from "convex/browser";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Task, RepoContext, Agent } from "./types.js";
import { callGateway, randomIdempotencyKey } from "../../gateway/call.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  resolveCliBin,
  resolveClaudeBin,
  buildClaudeArgs,
  buildPromptFromTemplate,
  buildPromptFromSkillTemplate,
} from "./agent-spawn.js";
import { api } from "./convex-client.js";
import { buildGoldenPathPrompt } from "./golden-path.js";
import { safeWriteLlmLog } from "./llm-log.js";
import { resolveExecutionCwdForTask } from "./repo-workspace.js";
import { appendFluxLog } from "./flux-log.js";

const log = createSubsystemLogger("flux").child("dispatcher");

/** Fetch the Design Protocol text from memory_kv. */
async function resolveDesignProtocol(client: ConvexClient): Promise<string> {
  try {
    const row = (await client.query(api.memory_kv.get, {
      scope: "global",
      namespace: "protocol",
      key: "design-protocol",
    })) as { valueJson: string } | null;
    if (row?.valueJson) {
      return JSON.parse(row.valueJson) as string;
    }
  } catch (e: unknown) {
    log.warn(`failed to resolve design protocol: ${String(e)}`);
  }
  return "(Design Protocol not available)";
}

/** Build compact system overview variables. */
async function buildSystemContextVars(
  vars: Record<string, string>,
  client: ConvexClient,
): Promise<void> {
  try {
    const [streams, runCounts] = await Promise.all([
      client.query(api.streams.list, { status: "active" }) as Promise<Array<{ _id: string }>>,
      client.query(api.runs.countByStatus, {}) as Promise<{
        total: number;
        byStatus: Record<string, number>;
      }>,
    ]);
    const bs = runCounts.byStatus ?? {};
    vars.SYSTEM_CONTEXT = [
      `Streams: ${streams.length} active`,
      `Runs: ${bs.running ?? 0} running / ${bs.paused ?? 0} paused / ${bs.completed ?? 0} completed`,
    ].join("\n");
  } catch (e: unknown) {
    log.warn(`failed to build system context: ${String(e)}`);
    vars.SYSTEM_CONTEXT = "(System context unavailable)";
  }
}

/** Build run context if task belongs to a run. */
async function buildRunContext(
  vars: Record<string, string>,
  task: Task,
  client: ConvexClient,
): Promise<void> {
  if (!task.runId) {
    vars.RUN_CONTEXT = "No run context.";
    return;
  }
  try {
    const [run, events] = await Promise.all([
      client.query(api.runs.get, { id: task.runId }) as Promise<{
        name?: string;
        status: string;
      } | null>,
      client.query(api.run_events.getLatest, {
        runId: task.runId,
        limit: 10,
      }) as Promise<Array<{ eventType: string; payload?: string }>>,
    ]);
    const eventLines = events
      .slice(0, 10)
      .map((e) => `- [${e.eventType}] ${(e.payload ?? "").slice(0, 100)}`)
      .join("\n");
    vars.RUN_CONTEXT = [
      `Run: ${run?.name ?? task.runId} (${run?.status ?? "unknown"})`,
      `Events: ${events.length} recent`,
      eventLines || "No events.",
    ].join("\n");
  } catch (e: unknown) {
    log.warn(`failed to build run context: ${String(e)}`);
    vars.RUN_CONTEXT = "Run context unavailable.";
  }
}

function resolveTierModel(
  tiers: Record<string, string>,
  costClass: "cheap" | "mid" | "high",
): string | undefined {
  if (tiers[costClass]) {
    return tiers[costClass];
  }
  if (costClass === "cheap" && tiers.low) {
    return tiers.low;
  }
  if (costClass === "mid" && tiers.medium) {
    return tiers.medium;
  }
  return undefined;
}

type CostClass = "cheap" | "mid" | "high";
type ToolPolicySource =
  | "step:allowedTools"
  | "template:allowedTools"
  | "skill:allowedTools"
  | "none";

type ExecutionTemplate = {
  name: string;
  version?: number;
  description?: string;
  promptTemplate: string;
  outputFormat?: string;
  outputSchema?: string;
  capableRoles?: string[];
  executionMode?: string;
  allowedTools?: string;
  requiredTools?: string[];
  model?: string;
  timeoutSec?: number;
  gated?: boolean;
  costClass?: CostClass;
};

type NodeExecutionHints = {
  key?: string;
  title?: string;
  skill?: string;
  skillSnapshotId?: string;
  skillSnapshotVersion?: number;
  executionTemplate?: ExecutionTemplate;
  model?: string;
  costClass?: CostClass;
  allowedTools?: string;
  skills: string[];
};

function normalizeCostClass(value: unknown): CostClass | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "cheap" || normalized === "low") {
    return "cheap";
  }
  if (normalized === "mid" || normalized === "medium") {
    return "mid";
  }
  if (normalized === "high") {
    return "high";
  }
  return undefined;
}

function inferDefaultCostClass(task: Task): CostClass | undefined {
  if (
    task.type === "operator" ||
    task.type === "strategist" ||
    task.source === "github" ||
    task.source === "intake" ||
    task.source === "operator"
  ) {
    return "cheap";
  }
  if (task.type === "playbook-agent" || task.source === "run") {
    return "mid";
  }
  return undefined;
}

function parseNodeExecutionHints(rawInput: string): NodeExecutionHints {
  try {
    const parsed = JSON.parse(rawInput) as Record<string, unknown>;
    const node =
      parsed.node && typeof parsed.node === "object" && !Array.isArray(parsed.node)
        ? (parsed.node as Record<string, unknown>)
        : null;
    if (!node) {
      return { skills: [] };
    }

    const key =
      typeof node.key === "string" && node.key.trim().length > 0 ? node.key.trim() : undefined;
    const title =
      typeof node.title === "string" && node.title.trim().length > 0
        ? node.title.trim()
        : undefined;
    const skill =
      typeof node.skill === "string" && node.skill.trim().length > 0
        ? node.skill.trim()
        : undefined;
    const skillSnapshotId =
      typeof node.skillSnapshotId === "string" && node.skillSnapshotId.trim().length > 0
        ? node.skillSnapshotId.trim()
        : undefined;
    const skillSnapshotVersion =
      typeof node.skillSnapshotVersion === "number" &&
      Number.isFinite(node.skillSnapshotVersion) &&
      node.skillSnapshotVersion > 0
        ? Math.floor(node.skillSnapshotVersion)
        : undefined;
    const model =
      typeof node.model === "string" && node.model.trim().length > 0
        ? node.model.trim()
        : undefined;
    const costClass = normalizeCostClass(node.costClass);
    const allowedTools =
      typeof node.allowedTools === "string" && node.allowedTools.trim().length > 0
        ? node.allowedTools.trim()
        : undefined;
    const skills = Array.isArray(node.skills)
      ? node.skills.map((s) => (typeof s === "string" ? s.trim() : "")).filter((s) => s.length > 0)
      : [];
    const executionTemplateRaw =
      node.executionTemplate &&
      typeof node.executionTemplate === "object" &&
      !Array.isArray(node.executionTemplate)
        ? (node.executionTemplate as Record<string, unknown>)
        : null;
    const executionTemplate =
      executionTemplateRaw &&
      typeof executionTemplateRaw.promptTemplate === "string" &&
      executionTemplateRaw.promptTemplate.trim().length > 0
        ? {
            name:
              typeof executionTemplateRaw.name === "string" &&
              executionTemplateRaw.name.trim().length > 0
                ? executionTemplateRaw.name.trim()
                : (skill ?? key ?? "playbook-skill"),
            ...(typeof executionTemplateRaw.version === "number" &&
            Number.isFinite(executionTemplateRaw.version)
              ? { version: Math.floor(executionTemplateRaw.version) }
              : {}),
            ...(typeof executionTemplateRaw.description === "string"
              ? { description: executionTemplateRaw.description }
              : {}),
            promptTemplate: executionTemplateRaw.promptTemplate.trim(),
            ...(typeof executionTemplateRaw.outputFormat === "string"
              ? { outputFormat: executionTemplateRaw.outputFormat }
              : {}),
            ...(typeof executionTemplateRaw.outputSchema === "string"
              ? { outputSchema: executionTemplateRaw.outputSchema }
              : {}),
            ...(Array.isArray(executionTemplateRaw.capableRoles)
              ? {
                  capableRoles: executionTemplateRaw.capableRoles
                    .map((role) => (typeof role === "string" ? role.trim() : ""))
                    .filter((role) => role.length > 0),
                }
              : {}),
            ...(typeof executionTemplateRaw.executionMode === "string"
              ? { executionMode: executionTemplateRaw.executionMode }
              : {}),
            ...(typeof executionTemplateRaw.allowedTools === "string"
              ? { allowedTools: executionTemplateRaw.allowedTools }
              : {}),
            ...(Array.isArray(executionTemplateRaw.requiredTools)
              ? {
                  requiredTools: executionTemplateRaw.requiredTools
                    .map((tool) => (typeof tool === "string" ? tool.trim() : ""))
                    .filter((tool) => tool.length > 0),
                }
              : {}),
            ...(typeof executionTemplateRaw.model === "string"
              ? { model: executionTemplateRaw.model }
              : {}),
            ...(typeof executionTemplateRaw.timeoutSec === "number" &&
            Number.isFinite(executionTemplateRaw.timeoutSec)
              ? { timeoutSec: executionTemplateRaw.timeoutSec }
              : {}),
            ...(executionTemplateRaw.gated === true ? { gated: true } : {}),
            ...(normalizeCostClass(executionTemplateRaw.costClass)
              ? { costClass: normalizeCostClass(executionTemplateRaw.costClass)! }
              : {}),
          }
        : undefined;
    return {
      key,
      title,
      skill,
      skillSnapshotId,
      skillSnapshotVersion,
      executionTemplate,
      model,
      costClass,
      allowedTools,
      skills,
    };
  } catch {
    return { skills: [] };
  }
}

function truncatePromptToBudget(
  message: string,
  maxPromptTokens: number,
): { message: string; truncated: boolean; removedChars: number } {
  const targetChars = Math.max(512, Math.floor(maxPromptTokens * 4));
  if (message.length <= targetChars) {
    return { message, truncated: false, removedChars: 0 };
  }

  const marker = "\n\n[...TRUNCATED FOR CONTEXT WINDOW...]\n\n";
  const keepChars = Math.max(0, targetChars - marker.length);
  const headChars = Math.max(200, Math.floor(keepChars * 0.75));
  const tailChars = Math.max(0, keepChars - headChars);

  const truncated =
    message.slice(0, headChars) + marker + (tailChars > 0 ? message.slice(-tailChars) : "");
  const removedChars = Math.max(0, message.length - (headChars + tailChars));
  return { message: truncated, truncated: true, removedChars };
}

const EXECUTION_PROMPT_LOG_PREFIX = "[execution.prompt.v1]";
const EXECUTION_PROMPT_LOG_MAX_CHARS = 20_000;

function buildExecutionPromptLogContent(args: {
  executionMode: string;
  model: string;
  prompt: string;
  promptChars: number;
  promptTokensApprox: number;
}): string {
  const { executionMode, model, prompt, promptChars, promptTokensApprox } = args;
  const omitted = Math.max(0, prompt.length - EXECUTION_PROMPT_LOG_MAX_CHARS);
  const promptBody =
    omitted > 0
      ? `${prompt.slice(0, EXECUTION_PROMPT_LOG_MAX_CHARS)}\n...[truncated ${omitted} chars]`
      : prompt;
  return [
    EXECUTION_PROMPT_LOG_PREFIX,
    `executionMode=${executionMode}`,
    `model=${model}`,
    `promptChars=${promptChars}`,
    `promptTokensApprox=${promptTokensApprox}`,
    "",
    promptBody,
  ].join("\n");
}

/** Parse Claude CLI JSON output — tries full parse, nested result, last JSON block, then raw. */
function parseClaudeOutput(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const inner = parsed.result ?? parsed.response;
    if (typeof inner === "string") {
      try {
        JSON.parse(inner);
        return inner;
      } catch {
        // inner is plain text
      }
    }
    return trimmed;
  } catch {
    // Not valid JSON
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      JSON.parse(match[0]);
      return match[0];
    } catch {
      // Not valid JSON
    }
  }
  return trimmed;
}

export type DispatchResult = {
  sessionId: string;
  convexSessionId: string;
  promise: Promise<{ ok: boolean; output: string }>;
  kill: () => void;
};

export type DispatchContext = {
  activeSessions: Map<string, DispatchResult>;
  pendingDispatch: Set<string>;
};

export function createDispatchContext(): DispatchContext {
  return {
    activeSessions: new Map(),
    pendingDispatch: new Set(),
  };
}

const defaultCtx = createDispatchContext();

export function getActiveSessions(): Map<string, DispatchResult> {
  return defaultCtx.activeSessions;
}

export function getActiveSessionCount(): number {
  return defaultCtx.activeSessions.size;
}

export function isDispatching(taskId: string): boolean {
  return defaultCtx.pendingDispatch.has(taskId);
}

function parseTaskInput(task: Task): Record<string, string> {
  const input: Record<string, string> = {
    INPUT: task.input,
  };
  try {
    const parsed = JSON.parse(task.input) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      if (v == null) {
        input[k] = "";
        continue;
      }
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        input[k] = String(v);
        continue;
      }
      try {
        input[k] = JSON.stringify(v);
      } catch {
        input[k] = "__unserializable_json_value__";
      }
    }
  } catch {
    // input is plain text, not JSON
  }
  return input;
}

function resolveExternalStatus(task: Task): string | undefined {
  if (typeof task.externalStatus === "string" && task.externalStatus.trim().length > 0) {
    return task.externalStatus.trim();
  }
  try {
    const parsed = JSON.parse(task.input) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const intake = (parsed as Record<string, unknown>).intake;
    if (!intake || typeof intake !== "object" || Array.isArray(intake)) {
      return undefined;
    }
    const externalStatus = (intake as Record<string, unknown>).externalStatus;
    return typeof externalStatus === "string" && externalStatus.trim().length > 0
      ? externalStatus.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

async function injectPredecessorOutputs(
  vars: Record<string, string>,
  task: Task,
  client: ConvexClient,
): Promise<void> {
  if (!task.contextFrom || task.contextFrom.length === 0) {
    return;
  }

  const predecessorOutputs: string[] = [];
  for (const predId of task.contextFrom.slice(0, 8)) {
    try {
      const predTask = (await client.query(api.tasks.get, { id: predId })) as {
        goal?: string;
        output?: string;
      } | null;
      if (predTask?.output) {
        predecessorOutputs.push(
          `## Output from: ${predTask.goal ?? predId}\n${predTask.output.slice(0, 4000)}`,
        );
      }
    } catch (e: unknown) {
      log.warn(`failed to load predecessor task ${predId}: ${String(e)}`);
    }
  }

  if (predecessorOutputs.length > 0) {
    vars.PREDECESSOR_OUTPUT = predecessorOutputs.join("\n\n---\n\n");
  }
}

/** Build compact stream context variables for conductor-chat and context injection. */
async function buildStreamContext(
  vars: Record<string, string>,
  task: Task,
  client: ConvexClient,
): Promise<void> {
  if (!task.streamId) {
    return;
  }
  try {
    const stream = (await client.query(api.streams.get, { id: task.streamId })) as {
      title?: string;
      intentMd?: string;
      horizon?: string;
    } | null;
    vars.STREAM_TITLE = stream?.title ?? "Unnamed Stream";
    vars.STREAM_INTENT = stream?.intentMd ? stream.intentMd.slice(0, 200) : "No intent set.";
    vars.STREAM_HORIZON = stream?.horizon ?? "unset";

    // Goals — titles + statuses (compact)
    const goals = (await client.query(api.goals.list, {
      streamId: task.streamId,
    })) as Array<{ title: string; status: string }>;
    vars.GOALS =
      goals.length > 0 ? goals.map((g) => `- ${g.title} (${g.status})`).join("\n") : "No goals.";

    // Metrics — name, current vs target (compact)
    const metrics = (await client.query(api.metrics.list, {
      streamId: task.streamId,
    })) as Array<{
      name: string;
      currentValue?: string;
      targetValue?: string;
      direction: string;
    }>;
    vars.METRICS =
      metrics.length > 0
        ? metrics
            .slice(0, 8)
            .map(
              (m) =>
                `${m.name}: ${m.currentValue ?? "n/a"} / ${m.targetValue ?? "n/a"} (${m.direction})`,
            )
            .join("\n")
        : "No metrics.";

    // Tasks — counts by status (~30 tokens)
    const counts = (await client.query(api.tasks.countByStatus, {
      streamId: task.streamId,
    })) as { byStatus?: Record<string, number> } | null;
    vars.TASK_SUMMARY =
      Object.entries(counts?.byStatus || {})
        .map(([s, c]) => `${s}: ${c}`)
        .join(", ") || "No tasks.";

    // Pulses — latest summary
    const latestPulse = (await client.query(api.pulses.getLatest, {
      streamId: task.streamId,
    })) as { summaryMd?: string } | null;
    vars.LATEST_PULSE = latestPulse?.summaryMd
      ? latestPulse.summaryMd.slice(0, 200)
      : "No pulses yet.";

    // Agents — compact
    const agents = (await client.query(api.agents.list, {})) as Array<{
      name: string;
      status: string;
    }>;
    const activeCount = agents.filter((a) => a.status === "active").length;
    vars.AGENTS = `${activeCount} active / ${agents.length} total: ${agents.map((a) => a.name).join(", ")}`;

    // Knowledge — top relevant entries
    const knowledge = (await client.query(api.knowledge.list, {
      streamId: task.streamId,
    })) as Array<{ title: string }>;
    vars.KNOWLEDGE =
      knowledge.length > 0
        ? knowledge
            .slice(0, 3)
            .map((k) => `- ${k.title}`)
            .join("\n")
        : "No knowledge entries.";

    // Conversation history for conductor-chat
    if (task.type === "conductor-chat") {
      const chatMessages = (await client.query(api.chat.listMessages, {
        streamId: task.streamId,
        limit: 6,
      })) as Array<{ role: string; content: string }>;
      const historyMessages = chatMessages.slice(0, -1);
      vars.CONVERSATION_HISTORY =
        historyMessages.length > 0
          ? historyMessages
              .map((m) => `**${m.role === "human" ? "User" : "AI"}**: ${m.content}`)
              .join("\n\n")
          : "No prior messages.";

      vars.PAGE_CONTEXT = vars.pageContext ?? "Dashboard (no specific page)";
      vars.MESSAGE = vars.message ?? "";
    }

    // Synthesize composite STREAM_CONTEXT for new prompt templates
    vars.STREAM_CONTEXT = [
      `Stream: ${vars.STREAM_TITLE} | Intent: ${vars.STREAM_INTENT}`,
      `Goals: ${vars.GOALS}`,
      `Metrics: ${vars.METRICS}`,
      `Tasks: ${vars.TASK_SUMMARY}`,
    ].join("\n");
  } catch (e: unknown) {
    log.warn(`failed to load stream context: ${String(e)}`);
  }
}

function clampText(value: string | undefined, max: number): string {
  if (!value) {
    return "";
  }
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

async function buildAgentSystemPrompt(
  agent: Agent,
  task: Task,
  client: ConvexClient,
): Promise<string> {
  const sections: string[] = [];
  sections.push("## Identity");
  sections.push(`You are **${agent.name}**${agent.role ? `, ${agent.role}` : ""}.`);
  if (agent.soul) {
    sections.push(`Soul: ${clampText(agent.soul, 900)}`);
  }
  if (agent.identity) {
    sections.push(`Identity: ${clampText(agent.identity, 700)}`);
  }
  if (agent.procedures) {
    sections.push(`Procedures:\n${agent.procedures}`);
  }
  if (agent.skills?.length) {
    sections.push(
      `Skills:\n${agent.skills
        .slice(0, 12)
        .map((s) => `- ${s}`)
        .join("\n")}`,
    );
  }

  sections.push("");
  sections.push("## Context");

  // Stream context instead of squad context
  if (task.streamId) {
    const stream = (await client.query(api.streams.get, { id: task.streamId })) as {
      title?: string;
      intentMd?: string;
      horizon?: string;
    } | null;
    sections.push(
      `Stream: ${stream?.title ?? "Unknown"}${stream?.intentMd ? ` — ${clampText(stream.intentMd, 200)}` : ""}`,
    );
    if (stream?.horizon) {
      sections.push(`Horizon: ${stream.horizon}`);
    }

    const goals = (await client.query(api.goals.list, {
      streamId: task.streamId,
    })) as Array<{ title: string; status: string }>;
    const activeGoals = goals
      .filter((g) => g.status !== "done" && g.status !== "skipped")
      .slice(0, 6);
    sections.push(
      `Active Goals:\n${
        activeGoals.length > 0
          ? activeGoals.map((g) => `- ${g.title} (${g.status})`).join("\n")
          : "- None"
      }`,
    );

    const metrics = (await client.query(api.metrics.list, {
      streamId: task.streamId,
    })) as Array<{
      name: string;
      currentValue?: string;
      targetValue?: string;
      direction: string;
    }>;
    const metricSummary = metrics
      .slice(0, 8)
      .map(
        (m) => `${m.name}: ${m.currentValue ?? "n/a"} / ${m.targetValue ?? "n/a"} (${m.direction})`,
      )
      .join("\n");
    sections.push(`Metrics:\n${metricSummary || "No metrics configured."}`);
  }

  // Active tasks context
  const activeTasks = (await client.query(
    api.tasks.list,
    task.streamId ? { streamId: task.streamId } : {},
  )) as Array<{ _id: string; goal: string; status: string; type: string }>;
  const filteredTasks = activeTasks
    .filter(
      (row) =>
        row._id !== task._id &&
        row.status !== "done" &&
        row.status !== "failed" &&
        row.type !== "conductor-chat",
    )
    .slice(0, 8);
  sections.push(
    `Active Tasks:\n${
      filteredTasks.length > 0
        ? filteredTasks.map((row) => `- [${row.status}] ${row.goal} (${row.type})`).join("\n")
        : "- No active tasks"
    }`,
  );

  return sections.join("\n");
}

type CompletionContext = {
  task: Task;
  executionTemplate: ExecutionTemplate;
  model: string | undefined;
  convexSessionId: string;
  startTime: number;
  client: ConvexClient;
};

function isIdempotentStatusTransitionError(error: unknown): boolean {
  const errorText = error instanceof Error ? error.message : String(error);
  const match = /Invalid transition:\s*([a-z_]+)\s*->\s*([a-z_]+)/i.exec(errorText);
  return Boolean(match && match[1] === match[2]);
}

async function updateTaskStatusWithNoopGuard(
  client: ConvexClient,
  args: {
    id: string;
    status: "todo" | "doing" | "blocked" | "review" | "done" | "failed";
    output?: string;
  },
): Promise<void> {
  try {
    await client.mutation(api.tasks.updateStatus, args);
  } catch (e: unknown) {
    if (!isIdempotentStatusTransitionError(e)) {
      throw e;
    }
  }
}

/** Handle task success or failure: update status, archive output. */
async function handleTaskCompletion(
  ok: boolean,
  output: string,
  cx: CompletionContext,
): Promise<void> {
  const { task, executionTemplate, model, convexSessionId, startTime, client } = cx;
  try {
    if (ok) {
      const isGated = executionTemplate.gated ?? false;
      const finalStatus = isGated ? "review" : "done";
      log.info(`task ${task._id} completed successfully → ${finalStatus}`);
      await updateTaskStatusWithNoopGuard(client, {
        id: task._id,
        status: finalStatus,
        output,
      });
      await client.mutation(api.agentSessions.updateStatus, {
        id: convexSessionId,
        status: "idle",
      });
      await client.mutation(api.events.create, {
        taskId: task._id,
        type: "result",
        content: output.slice(0, 10_000),
        fromAgent: task.type,
      });
      if (isGated) {
        await client.mutation(api.events.create, {
          taskId: task._id,
          type: "gate_pending",
          content: "Task completed — awaiting human approval",
          fromAgent: "supervisor",
        });
      }

      // Archive output for quality tracking
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      await client.mutation(api.task_outputs_archive.archive, {
        taskId: task._id,
        taskType: task.type,
        model,
        durationSec,
        outputJson: output.slice(0, 50_000),
      });

      // Process conductor-chat output
      if (task.type === "conductor-chat") {
        await processConductorChatOutput(output, task._id, task.streamId, client, task.input);
      }
    } else {
      log.error(`task ${task._id} failed: ${output.slice(0, 200)}`);
      await updateTaskStatusWithNoopGuard(client, {
        id: task._id,
        status: "failed",
        output: output.slice(0, 2000),
      });
      await client.mutation(api.agentSessions.updateStatus, {
        id: convexSessionId,
        status: "failed",
      });
      await client.mutation(api.events.create, {
        taskId: task._id,
        type: "error",
        content: output.slice(0, 2000),
        fromAgent: task.type,
      });

      // Store error feedback in chat
      if (task.type === "conductor-chat" && task.streamId) {
        try {
          await client.mutation(api.chat.storeResponse, {
            streamId: task.streamId,
            taskId: task._id,
            content: `*Failed to process your message. The agent encountered an error.*\n\n\`\`\`\n${output.slice(0, 500)}\n\`\`\``,
          });
        } catch (chatErr: unknown) {
          log.warn(`failed to store chat error message: ${String(chatErr)}`);
        }
      }
    }
  } catch (e: unknown) {
    log.error(`failed to update task/session status: ${String(e)}`);
  }
}

/** Minimal conductor-chat output processing — extract message and store response. */
async function processConductorChatOutput(
  output: string,
  taskId: string,
  streamId: string | undefined,
  client: ConvexClient,
  taskInput?: string,
): Promise<void> {
  let assistantMessageId: string | undefined;
  if (taskInput) {
    try {
      const inputData = JSON.parse(taskInput) as { assistantMessageId?: string };
      assistantMessageId = inputData.assistantMessageId;
    } catch {
      // input wasn't JSON
    }
  }

  let message = output;
  let actions: string | undefined;

  // Try to parse JSON response
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (typeof parsed.message === "string") {
      message = parsed.message;
    }
    if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
      actions = JSON.stringify(parsed.actions);
    }
  } catch {
    // output is not JSON, use raw
  }

  if (assistantMessageId) {
    await client.mutation(api.chat.completeChatResponse, {
      messageId: assistantMessageId,
      content: message.slice(0, 10_000),
      actions,
    });
  } else if (streamId) {
    await client.mutation(api.chat.storeResponse, {
      streamId,
      taskId,
      content: message.slice(0, 10_000),
      actions,
    });
  }
}

/** Gateway-based dispatch for conductor-chat tasks (dashboard chat). */
async function dispatchConductorChatViaGateway(
  task: Task,
  client: ConvexClient,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const sessionId = randomUUID();

  ctx.pendingDispatch.add(task._id);

  if (!task.skillId) {
    throw new Error(`task ${task._id} has no skillId`);
  }
  const skill = (await client.query(api.skills.get, { id: task.skillId })) as {
    _id: string;
    name: string;
    version?: number;
    description?: string;
    promptTemplate?: string;
    outputFormat?: string;
    outputSchema?: string;
    capableRoles?: string[];
    allowedTools?: string[];
    model?: string;
    timeoutSec?: number;
    gated?: boolean;
    costClass?: CostClass;
    enabled?: boolean;
    type?: string;
  } | null;
  if (!skill) {
    throw new Error(`skill ${task.skillId} not found`);
  }
  if (skill.enabled === false) {
    throw new Error(`skill ${task.skillId} is disabled`);
  }
  if (typeof skill.promptTemplate !== "string" || skill.promptTemplate.trim().length === 0) {
    throw new Error(`skill ${task.skillId} has no promptTemplate`);
  }
  const executionTemplate: ExecutionTemplate = {
    name: skill.name,
    ...(typeof skill.version === "number" ? { version: skill.version } : {}),
    description: skill.description,
    promptTemplate: skill.promptTemplate,
    outputFormat: skill.outputFormat,
    outputSchema: skill.outputSchema,
    capableRoles: skill.capableRoles,
    executionMode: "gateway",
    allowedTools: Array.isArray(skill.allowedTools) ? skill.allowedTools.join(", ") : undefined,
    model: skill.model,
    timeoutSec: skill.timeoutSec,
    gated: skill.gated,
    costClass: skill.costClass,
  };

  let openclawAgentId = "main";

  log.info(
    `dispatching conductor-chat via gateway (task: ${task._id}, agent: ${openclawAgentId}, session: ${sessionId.slice(0, 8)}, model: gateway-default)`,
  );

  const convexSessionId: string = await client.mutation(api.agentSessions.startRun, {
    taskId: task._id,
    sessionId,
  });

  await updateTaskStatusWithNoopGuard(client, {
    id: task._id,
    status: "doing",
  });

  const startTime = Date.now();

  const vars = parseTaskInput(task);
  await buildStreamContext(vars, task, client);

  // Resolve agent persona for conductor-chat
  if (task.agentId) {
    try {
      const agent = (await client.query(api.agents.get, { id: task.agentId })) as Agent | null;
      if (agent) {
        vars.AGENT_NAME = agent.name;
        vars.AGENT_SOUL = agent.soul ?? "";
        vars.AGENT_SKILLS = agent.skills?.join(", ") ?? "";
        vars.LEADER_NAME = agent.name;
      }
    } catch (e: unknown) {
      log.warn(`failed to load agent for conductor-chat: ${String(e)}`);
    }
  }
  vars.DESIGN_PROTOCOL = await resolveDesignProtocol(client);
  await buildSystemContextVars(vars, client);
  vars.TASK_GOAL = task.goal;
  vars.INPUT_JSON = task.input;

  const message = buildPromptFromTemplate(executionTemplate.promptTemplate, vars);

  log.info(
    `conductor-chat message built (~${Math.round(message.length / 4)} tokens, ${message.length} chars)`,
  );

  appendFluxLog({
    stage: "INPUT",
    metadata: {
      taskId: task._id,
      taskType: task.type,
      skill: `${executionTemplate.name}${typeof executionTemplate.version === "number" ? ` v${executionTemplate.version}` : ""}`,
      executionMode: "gateway",
      agent: openclawAgentId,
      model: "gateway-default",
      promptChars: message.length,
      promptTokensApprox: Math.round(message.length / 4),
    },
    sections: [{ label: "PROMPT", content: message }],
  });

  const promise = (async (): Promise<{ ok: boolean; output: string }> => {
    try {
      const result = await callGateway<{
        status?: string;
        summary?: string;
        result?: {
          payloads?: Array<{ text?: string }>;
        };
      }>({
        method: "agent",
        params: {
          agentId: openclawAgentId,
          sessionKey: `agent:${openclawAgentId}:main`,
          message,
          timeout: 90,
          idempotencyKey: randomIdempotencyKey(),
        },
        expectFinal: true,
        timeoutMs: 120_000,
      });

      const payloads = result.result?.payloads ?? [];
      const reply =
        payloads
          .map((p) => p.text ?? "")
          .join("\n")
          .trim() ||
        result.summary ||
        "";

      appendFluxLog({
        stage: "OUTPUT",
        metadata: {
          taskId: task._id,
          taskType: task.type,
          executionMode: "gateway",
          agent: openclawAgentId,
          model: "gateway-default",
          durationSec: Math.round((Date.now() - startTime) / 1000),
          outputChars: reply.length,
        },
        sections: [{ label: "RETURNED_OUTPUT", content: reply }],
      });
      await safeWriteLlmLog(client, {
        taskId: task._id,
        runId: task.runId,
        source: "dispatcher.conductor_gateway",
        provider: "openclaw-gateway",
        model: "gateway-default",
        openclawAgentId,
        requestText: message,
        responseText: reply,
        durationMs: Date.now() - startTime,
        isError: false,
      });

      await handleTaskCompletion(true, reply, {
        task,
        executionTemplate,
        model: undefined,
        convexSessionId,
        startTime,
        client,
      });

      return { ok: true, output: reply };
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);

      appendFluxLog({
        stage: "ERROR",
        metadata: {
          taskId: task._id,
          taskType: task.type,
          executionMode: "gateway",
          agent: openclawAgentId,
          model: "gateway-default",
          durationSec: Math.round((Date.now() - startTime) / 1000),
        },
        sections: [{ label: "ERROR_OUTPUT", content: errMsg }],
      });
      await safeWriteLlmLog(client, {
        taskId: task._id,
        runId: task.runId,
        source: "dispatcher.conductor_gateway",
        provider: "openclaw-gateway",
        model: "gateway-default",
        openclawAgentId,
        requestText: message,
        responseText: errMsg,
        durationMs: Date.now() - startTime,
        isError: true,
        errorText: errMsg,
      });

      await handleTaskCompletion(false, errMsg, {
        task,
        executionTemplate,
        model: undefined,
        convexSessionId,
        startTime,
        client,
      });

      return { ok: false, output: errMsg };
    } finally {
      ctx.activeSessions.delete(task._id);
      ctx.pendingDispatch.delete(task._id);
    }
  })();

  const result: DispatchResult = {
    sessionId,
    convexSessionId,
    promise,
    kill: () => {},
  };

  ctx.activeSessions.set(task._id, result);
  return result;
}

export async function dispatchTask(
  task: Task,
  client: ConvexClient,
  ctx: DispatchContext = defaultCtx,
): Promise<DispatchResult> {
  if (task.type === "conductor-chat") {
    return dispatchConductorChatViaGateway(task, client, ctx);
  }

  const sessionId = randomUUID();

  ctx.pendingDispatch.add(task._id);

  const nodeHints = parseNodeExecutionHints(task.input);
  let executionTemplate: ExecutionTemplate;
  if (nodeHints.executionTemplate) {
    executionTemplate = nodeHints.executionTemplate;
  } else if (task.skillId) {
    const skill = (await client.query(api.skills.get, { id: task.skillId })) as {
      _id: string;
      name: string;
      version?: number;
      description?: string;
      promptTemplate?: string;
      outputFormat?: string;
      outputSchema?: string;
      capableRoles?: string[];
      executionMode?: string;
      allowedTools?: string[];
      requiredTools?: string[];
      model?: string;
      timeoutSec?: number;
      gated?: boolean;
      costClass?: CostClass;
      enabled?: boolean;
    } | null;
    if (!skill) {
      throw new Error(`skill ${task.skillId} not found`);
    }
    if (skill.enabled === false) {
      throw new Error(`skill ${task.skillId} is disabled`);
    }
    if (typeof skill.promptTemplate !== "string" || skill.promptTemplate.trim().length === 0) {
      throw new Error(`skill ${task.skillId} has no promptTemplate`);
    }
    executionTemplate = {
      name: skill.name,
      ...(typeof skill.version === "number" ? { version: skill.version } : {}),
      description: skill.description,
      promptTemplate: skill.promptTemplate,
      outputFormat: skill.outputFormat,
      outputSchema: skill.outputSchema,
      capableRoles: skill.capableRoles,
      executionMode: skill.executionMode,
      allowedTools: Array.isArray(skill.allowedTools) ? skill.allowedTools.join(", ") : undefined,
      requiredTools: skill.requiredTools,
      model: skill.model,
      timeoutSec: skill.timeoutSec,
      gated: skill.gated,
      costClass: skill.costClass,
    };
  } else {
    throw new Error(`task ${task._id} has no execution template and no skillId`);
  }

  if (task.workflow === "product-development") {
    executionTemplate.executionMode = "claude-cli";
    executionTemplate.allowedTools =
      executionTemplate.allowedTools ??
      [
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Bash(git *)",
        "Bash(gh *)",
        "Bash(pnpm *)",
        "Bash(node *)",
        "Bash(bun *)",
        "Bash(rg *)",
        "Bash(ls *)",
        "Bash(cat *)",
        "Bash(jq *)",
      ].join(",");
  }

  let model: string | undefined;
  let modelSource = "default";
  let requestedCostClass: CostClass | undefined;
  let __requestedCostClassSource = "none";
  let resolvedAllowedTools = executionTemplate.allowedTools;
  let __toolPolicySource: ToolPolicySource = executionTemplate.allowedTools
    ? "template:allowedTools"
    : "none";
  let modelTierCache: Record<string, string> | null | undefined;
  let agentSystemPrompt: string | undefined;
  let operatorAgentName: string | undefined;

  if (nodeHints.allowedTools) {
    resolvedAllowedTools = nodeHints.allowedTools;
    __toolPolicySource = "step:allowedTools";
  }

  async function loadModelTiers(): Promise<Record<string, string> | undefined> {
    if (modelTierCache !== undefined) {
      return modelTierCache ?? undefined;
    }
    try {
      // Try memory_kv first (allows runtime model swaps without code changes)
      const tierKeys = ["cheap", "mid", "high"] as const;
      const results = await Promise.all(
        tierKeys.map((key) =>
          client.query(api.memory_kv.get, {
            scope: "global",
            namespace: "config:models",
            key,
          }) as Promise<{ valueJson: string } | null>,
        ),
      );
      const tiers: Record<string, string> = {};
      let found = false;
      for (let i = 0; i < tierKeys.length; i++) {
        const row = results[i];
        if (row?.valueJson) {
          tiers[tierKeys[i]] = JSON.parse(row.valueJson) as string;
          found = true;
        }
      }
      if (found) {
        modelTierCache = tiers;
        return tiers;
      }

      // Fall through to admin table
      const tiersStr = await client.query(api.admin.getValue, { key: "modelTiers" });
      if (!tiersStr) {
        modelTierCache = null;
        return undefined;
      }
      modelTierCache = JSON.parse(tiersStr as string) as Record<string, string>;
      return modelTierCache;
    } catch (e: unknown) {
      log.warn(`failed to resolve costClass tier: ${String(e)}`);
      modelTierCache = null;
      return undefined;
    }
  }

  async function resolveModelFromCostClass(
    costClass: CostClass,
    source: "step:costClass" | "skill:costClass" | "template:costClass" | "policy:taskDefault",
  ): Promise<string | undefined> {
    const tiers = await loadModelTiers();
    if (!tiers) {
      return undefined;
    }
    const mapped = resolveTierModel(tiers, costClass);
    if (mapped) {
      log.info(`${source} "${costClass}" → model "${mapped}"`);
    }
    return mapped;
  }

  if (nodeHints.model) {
    model = nodeHints.model;
    modelSource = "step:model";
  } else if (nodeHints.costClass) {
    requestedCostClass = nodeHints.costClass;
    __requestedCostClassSource = "step:costClass";
    const mapped = await resolveModelFromCostClass(nodeHints.costClass, "step:costClass");
    if (mapped) {
      model = mapped;
      modelSource = "step:costClass";
    }
  }

  if (!model && executionTemplate.model) {
    model = executionTemplate.model;
    modelSource = "template:model";
  }
  if (!model && executionTemplate.costClass) {
    requestedCostClass = executionTemplate.costClass;
    __requestedCostClassSource = "template:costClass";
    const mapped = await resolveModelFromCostClass(
      executionTemplate.costClass,
      "template:costClass",
    );
    if (mapped) {
      model = mapped;
      modelSource = "template:costClass";
    }
  }
  if (!model && !requestedCostClass) {
    const inferredCostClass = inferDefaultCostClass(task);
    if (inferredCostClass) {
      requestedCostClass = inferredCostClass;
      __requestedCostClassSource = "policy:taskDefault";
      const mapped = await resolveModelFromCostClass(inferredCostClass, "policy:taskDefault");
      if (mapped) {
        model = mapped;
        modelSource = "policy:taskDefault";
      }
    }
  }

  log.info(
    `dispatching task ${task._id} (type: ${task.type}, skill: ${executionTemplate.name}${typeof executionTemplate.version === "number" ? ` v${executionTemplate.version}` : ""}, session: ${sessionId.slice(0, 8)})`,
  );

  const convexSessionId: string = await client.mutation(api.agentSessions.startRun, {
    taskId: task._id,
    sessionId,
    model,
  });

  await updateTaskStatusWithNoopGuard(client, {
    id: task._id,
    status: "doing",
  });

  const vars = parseTaskInput(task);
  vars.title = vars.title ?? task.goal;
  if (nodeHints.key) {
    vars.PLAYBOOK_NODE_KEY = nodeHints.key;
  }
  if (nodeHints.title) {
    vars.PLAYBOOK_NODE_TITLE = nodeHints.title;
  }
  if (nodeHints.skills.length > 0) {
    vars.NODE_SKILLS = nodeHints.skills.join(", ");
  }
  await injectPredecessorOutputs(vars, task, client);

  // Inject stream context
  await buildStreamContext(vars, task, client);

  // Inject Design Protocol, system context, and run context
  vars.DESIGN_PROTOCOL = await resolveDesignProtocol(client);
  await buildSystemContextVars(vars, client);
  await buildRunContext(vars, task, client);
  vars.TASK_GOAL = task.goal;
  vars.INPUT_JSON = task.input;

  // Inject goal context if goalId present
  if (task.goalId) {
    try {
      const goal = (await client.query(api.goals.get, { id: task.goalId })) as {
        title: string;
        description?: string;
        status: string;
      } | null;
      if (goal) {
        vars.GOAL_TITLE = goal.title;
        vars.GOAL_DESCRIPTION = goal.description ?? "";
        vars.GOAL_STATUS = goal.status;
      }
    } catch (e: unknown) {
      log.warn(`failed to load goal context for task ${task._id}: ${String(e)}`);
    }
  }

  // Inject agent persona into prompt vars
  if (task.agentId) {
    try {
      const agent = (await client.query(api.agents.get, { id: task.agentId })) as Agent | null;
      if (agent) {
        operatorAgentName = agent.name;
        vars.AGENT_NAME = agent.name;
        vars.AGENT_ROLE = agent.role ?? "";
        agentSystemPrompt = await buildAgentSystemPrompt(agent, task, client);
        vars.AGENT_PERSONA = agentSystemPrompt;
        vars.AGENT_SOUL = agent.soul ?? "";
        vars.AGENT_SKILLS = agent.skills?.join(", ") ?? "";

        if (!model && agent.model) {
          model = agent.model;
          modelSource = "agent:model";
        }
      }
    } catch (e: unknown) {
      log.warn(`failed to load agent persona for task ${task._id}: ${String(e)}`);
    }
  }

  const isClaudeCliExecution = executionTemplate.executionMode === "claude-cli";
  if (isClaudeCliExecution && model?.startsWith("lmstudio/")) {
    log.warn(
      `task ${task._id} resolved local model "${model}" for claude-cli; dropping model override`,
    );
    model = undefined;
    modelSource = "executionMode:claude-cli-default";
  }

  if (model && !model.includes("/")) {
    log.warn(
      `task ${task._id} resolved unqualified model "${model}" (${modelSource}); dropping to use default`,
    );
    model = undefined;
    modelSource = "model:unqualified-dropped";
  }

  const { cwd: executionCwd, repoContext: taskRepoContext } = await resolveExecutionCwdForTask(
    task,
    client,
  );

  let repoCtx: RepoContext = {
    owner: taskRepoContext?.owner,
    repo: taskRepoContext?.repo,
    repoPath: taskRepoContext?.repoPath,
  };

  const maybeExternalStatus = resolveExternalStatus(task);

  let __goldenPathStageKey: string | undefined;
  let __goldenPathSkill: string | undefined;
  let builtPrompt: string;
  if (task.workflow === "product-development" && executionCwd && maybeExternalStatus) {
    const golden = await buildGoldenPathPrompt({
      task,
      repoRoot: executionCwd,
      repo: repoCtx,
      externalStatus: maybeExternalStatus,
      nodeKey: nodeHints.key,
    });

    if (golden.kind === "noop") {
      const output = golden.reason;
      const startTime = Date.now();

      const promise = (async () => {
        try {
          appendFluxLog({
            stage: "OUTPUT",
            metadata: {
              taskId: task._id,
              taskType: task.type,
              executionMode: executionTemplate.executionMode ?? "openclaw-agent",
              goldenPath: "noop",
              externalStatus: maybeExternalStatus,
            },
            sections: [{ label: "NOOP", content: output }],
          });

          await client.mutation(api.events.create, {
            taskId: task._id,
            type: "log",
            content: `Golden path: no-op (${maybeExternalStatus})`,
            fromAgent: "supervisor",
          });

          await handleTaskCompletion(true, output, {
            task,
            executionTemplate,
            model,
            convexSessionId,
            startTime,
            client,
          });
          return { ok: true, output };
        } finally {
          ctx.activeSessions.delete(task._id);
          ctx.pendingDispatch.delete(task._id);
        }
      })();

      const result: DispatchResult = {
        sessionId,
        convexSessionId,
        promise,
        kill: () => {},
      };

      ctx.activeSessions.set(task._id, result);
      return result;
    }

    if (golden.kind === "mapped") {
      __goldenPathStageKey = golden.stageKey;
      __goldenPathSkill = golden.skillRelPath;
      builtPrompt = golden.prompt;
    } else {
      builtPrompt = await buildPromptFromSkillTemplate(
        executionTemplate.promptTemplate,
        task.source,
        vars,
        repoCtx,
      );
    }
  } else {
    builtPrompt = await buildPromptFromSkillTemplate(
      executionTemplate.promptTemplate,
      task.source,
      vars,
      repoCtx,
    );
  }

  const templateIncludesPersonaVar = executionTemplate.promptTemplate.includes("{AGENT_PERSONA}");
  const corePrompt = builtPrompt ?? `Task: ${task.goal}\n\nContext:\n${task.input}`;
  const rawMessage =
    agentSystemPrompt && !templateIncludesPersonaVar
      ? `${agentSystemPrompt}\n\n${corePrompt}`
      : corePrompt;

  const isLocalModel = model?.startsWith("lmstudio/") ?? false;
  const localContextTokens =
    Number.parseInt(process.env.SQUAD_LOCAL_CONTEXT_TOKENS ?? "", 10) || 8_192;
  const localReserveTokens =
    Number.parseInt(process.env.SQUAD_LOCAL_PROMPT_RESERVE_TOKENS ?? "", 10) || 1_536;
  const maxPromptTokens = isLocalModel
    ? Math.max(1_024, localContextTokens - localReserveTokens)
    : 150_000;

  const truncation = truncatePromptToBudget(rawMessage, maxPromptTokens);
  const message = truncation.message;

  const estimatedTokens = Math.round(message.length / 4);
  if (truncation.truncated) {
    log.warn(
      `task ${task._id} prompt truncated (~${Math.round(rawMessage.length / 4)} -> ~${estimatedTokens} tokens)`,
    );
    await client.mutation(api.events.create, {
      taskId: task._id,
      type: "log",
      content: `Prompt truncated: ~${Math.round(rawMessage.length / 4)} -> ~${estimatedTokens} tokens`,
      fromAgent: "supervisor",
    });
  }
  log.info(
    `task ${task._id} prompt built (~${estimatedTokens} tokens, ${message.length} chars, model: ${model ?? "default"})`,
  );

  appendFluxLog({
    stage: "INPUT",
    metadata: {
      taskId: task._id,
      taskType: task.type,
      skill: `${executionTemplate.name}${typeof executionTemplate.version === "number" ? ` v${executionTemplate.version}` : ""}`,
      executionMode: executionTemplate.executionMode ?? "openclaw-agent",
      agent: isClaudeCliExecution ? "claude-cli" : "main",
      model: model ?? "default",
      modelSource,
      promptChars: message.length,
      promptTokensApprox: estimatedTokens,
      source: task.source ?? "unknown",
    },
    sections: [{ label: "PROMPT", content: message }],
  });

  try {
    await client.mutation(api.events.create, {
      taskId: task._id,
      type: "log",
      content: buildExecutionPromptLogContent({
        executionMode: executionTemplate.executionMode ?? "openclaw-agent",
        model: model ?? "default",
        prompt: message,
        promptChars: message.length,
        promptTokensApprox: estimatedTokens,
      }),
      fromAgent: "supervisor",
    });
  } catch (e: unknown) {
    log.warn(`failed to write execution resolution event: ${String(e)}`);
  }

  if (estimatedTokens > maxPromptTokens) {
    const errMsg = `Prompt too large: ~${estimatedTokens} tokens exceeds ${maxPromptTokens} limit`;
    log.error(errMsg);
    ctx.pendingDispatch.delete(task._id);
    await client.mutation(api.tasks.updateStatus, {
      id: task._id,
      status: "failed",
      output: errMsg,
    });
    await client.mutation(api.agentSessions.updateStatus, {
      id: convexSessionId,
      status: "failed",
    });
    return {
      sessionId,
      convexSessionId,
      promise: Promise.resolve({ ok: false, output: errMsg }),
      kill: () => {},
    };
  }

  const isClaudeCli = isClaudeCliExecution;
  let command: string;
  let args: string[];

  if (isClaudeCli) {
    const bin = resolveClaudeBin();
    command = bin.command;
    args = [
      ...bin.prefixArgs,
      ...buildClaudeArgs({
        prompt: message,
        model,
        allowedTools: resolvedAllowedTools,
        outputFormat: "json",
      }),
    ];
    log.info(`spawning claude-cli for task ${task._id}`);
  } else {
    const bin = resolveCliBin();
    command = bin.command;
    const agentId = "main";
    args = [
      ...bin.prefixArgs,
      "agent",
      "--local",
      "--agent",
      agentId,
      "--message",
      message,
      "--thinking",
      "low",
    ];
    if (model) {
      args.push("--model", model);
    }
    log.info(
      `spawning: ${command} ${bin.prefixArgs.length > 0 ? bin.prefixArgs[0].split("/").pop() + " " : ""}agent ...`,
    );
  }

  const startTime = Date.now();
  const timeoutSec = executionTemplate.timeoutSec ?? 600;
  const spawnCwd = executionCwd ?? process.cwd();
  const child = spawn(command, args, {
    cwd: spawnCwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  let stdout = "";
  let stderr = "";
  let settled = false;

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const heartbeatTimer = setInterval(() => {
    client
      .mutation(api.agentSessions.heartbeat, {
        id: convexSessionId,
        phase: "running",
      })
      .then(() => client.query(api.agentSessions.getByTask, { taskId: task._id }))
      .then((session) => {
        if (session?.killedAt && !settled) {
          log.info(`session ${convexSessionId} killed from dashboard — sending SIGTERM`);
          child.kill("SIGTERM");
        }
      })
      .catch((e: unknown) => log.warn(`heartbeat failed: ${String(e)}`));
  }, 30_000);

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  function clearProcessTimers() {
    clearInterval(heartbeatTimer);
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
  }

  const promise = new Promise<{ ok: boolean; output: string }>((resolvePromise) => {
    async function settle(
      ok: boolean,
      output: string,
      metadata?: { exitCode?: number | null; trigger?: string },
    ) {
      if (settled) {
        return;
      }
      settled = true;

      clearProcessTimers();
      ctx.activeSessions.delete(task._id);
      ctx.pendingDispatch.delete(task._id);
      const durationSec = Math.round((Date.now() - startTime) / 1000);

      appendFluxLog({
        stage: ok ? "OUTPUT" : "ERROR",
        metadata: {
          taskId: task._id,
          taskType: task.type,
          executionMode: executionTemplate.executionMode ?? "openclaw-agent",
          agent: isClaudeCli ? "claude-cli" : "main",
          model: model ?? "default",
          durationSec,
          exitCode: metadata?.exitCode ?? "unknown",
          trigger: metadata?.trigger ?? "unknown",
          outputChars: output.length,
        },
        sections: [
          { label: "RETURNED_OUTPUT", content: output },
          { label: "STDERR_RAW", content: stderr },
        ],
      });
      await safeWriteLlmLog(client, {
        taskId: task._id,
        runId: task.runId,
        source: `dispatcher.${executionTemplate.executionMode ?? "openclaw-agent"}`,
        provider: isClaudeCli ? "claude-cli" : "openclaw-agent",
        model,
        operatorAgentId: task.agentId,
        operatorAgentName,
        openclawAgentId: isClaudeCli ? undefined : "main",
        requestText: message,
        responseText: output,
        durationMs: Date.now() - startTime,
        isError: !ok,
        errorText: ok ? undefined : output,
      });

      await handleTaskCompletion(ok, output, {
        task,
        executionTemplate,
        model,
        convexSessionId,
        startTime,
        client,
      });

      resolvePromise({ ok, output });
    }

    child.on("close", (code) => {
      const ok = code === 0;
      let output: string;
      if (isClaudeCli && ok) {
        output = parseClaudeOutput(stdout);
      } else {
        output = stdout.trim() || stderr.trim() || `Exit code ${String(code)}`;
      }
      void settle(ok, output, { exitCode: code, trigger: "close" });
    });

    child.on("error", (err) => {
      void settle(false, `Spawn error: ${err.message}`, {
        exitCode: null,
        trigger: "spawn_error",
      });
    });

    timeoutTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      log.warn(`task ${task._id} timed out after ${timeoutSec}s — sending SIGTERM`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          log.warn(`task ${task._id} still running after timeout grace period — sending SIGKILL`);
          child.kill("SIGKILL");
        }
      }, 5000);

      const partial = (stdout.trim() || stderr.trim()).slice(0, 2000);
      const msg = partial
        ? `Timeout: task exceeded ${timeoutSec}s limit. Partial output: ${partial}`
        : `Timeout: task exceeded ${timeoutSec}s limit.`;
      void settle(false, msg, { exitCode: null, trigger: "timeout" });
    }, timeoutSec * 1000);
  });
  void promise.finally(() => clearProcessTimers());

  const result: DispatchResult = {
    sessionId,
    convexSessionId,
    promise,
    kill: () => {
      child.kill("SIGTERM");
    },
  };

  ctx.activeSessions.set(task._id, result);
  return result;
}
