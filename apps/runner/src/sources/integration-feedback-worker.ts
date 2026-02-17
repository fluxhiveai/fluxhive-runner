import type { ConvexClient } from "convex/browser";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { GitHubAuth } from "../capabilities/github/types.js";
import type { RuntimeContext } from "../core/types.js";
import type { TaskSource } from "./source.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createGitHubCapabilityProvider } from "../capabilities/github/provider-factory.js";
import { api } from "../core/convex-client.js";

const log = createSubsystemLogger("flux").child("integration-feedback");

type BackoffState = {
  failures: number;
  backoffUntil: number;
};

type FeedbackEventRow = {
  _id: string;
  integrationId: string;
  topic: "run" | "task";
  taskId?: string;
  eventType: string;
  payloadJson: string;
};

type IntegrationRow = {
  _id: string;
  type: string;
  config?: unknown;
  intakeConfig?: unknown;
  secretRef?: string;
  enabled: boolean;
};

type TaskRow = {
  _id: string;
  goal: string;
  input: string;
};

type ExecutionRepoContext = {
  repoPath?: string;
};

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function expandHomeDir(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return {};
  }
}

function parseTaskInput(raw: string): Record<string, unknown> {
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return {};
  }
}

function resolveTokenFromSecretRef(secretRef: string | undefined): string | undefined {
  if (typeof secretRef !== "string" || secretRef.trim().length === 0) {
    return undefined;
  }
  const trimmed = secretRef.trim();
  if (!trimmed.startsWith("env:")) {
    return undefined;
  }
  const envKey = trimmed.slice(4).trim();
  if (envKey.length === 0) {
    return undefined;
  }
  const value = process.env[envKey];
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return value.trim();
}

function resolveRepoPathFromIntegration(integration: IntegrationRow): string | undefined {
  const configObj = asObject(integration.config);
  const intakeObj = asObject(integration.intakeConfig);
  const candidates = [
    intakeObj.repoPath,
    intakeObj.localRepoPath,
    intakeObj.workspacePath,
    configObj.repoPath,
    configObj.localRepoPath,
    configObj.workspacePath,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function resolveGitHubAuth(integration: IntegrationRow): GitHubAuth {
  const configObj = asObject(integration.config);
  const intakeObj = asObject(integration.intakeConfig);
  const tokenRaw =
    intakeObj.token ?? configObj.token ?? resolveTokenFromSecretRef(integration.secretRef);
  const token =
    typeof tokenRaw === "string" && tokenRaw.trim().length > 0 ? tokenRaw.trim() : undefined;
  return { kind: "token", ...(token ? { token } : {}) };
}

function parseResourceId(
  input: string,
): { owner: string; repo: string; issueNumber: number } | null {
  const match = input.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (!match) {
    return null;
  }
  const issueNumber = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return null;
  }
  return {
    owner: match[1] ?? "",
    repo: match[2] ?? "",
    issueNumber,
  };
}

function resolveIssueRef(params: {
  payload: Record<string, unknown>;
  task: TaskRow | null;
  integration: IntegrationRow;
}): { owner: string; repo: string; issueNumber: number } | null {
  const payloadResourceId =
    typeof params.payload.resourceId === "string" ? params.payload.resourceId : undefined;
  const payloadIssueNumber =
    typeof params.payload.issueNumber === "number" ? params.payload.issueNumber : undefined;
  if (
    payloadIssueNumber &&
    Number.isInteger(payloadIssueNumber) &&
    payloadIssueNumber > 0 &&
    payloadResourceId
  ) {
    const parsed = parseResourceId(payloadResourceId);
    if (parsed) {
      return {
        owner: parsed.owner,
        repo: parsed.repo,
        issueNumber: payloadIssueNumber,
      };
    }
  }

  const taskInput = params.task ? parseTaskInput(params.task.input) : {};
  const intakeObj = asObject(taskInput.intake);
  const taskResourceId =
    typeof intakeObj.resourceId === "string" ? intakeObj.resourceId : payloadResourceId;
  if (taskResourceId) {
    const parsed = parseResourceId(taskResourceId);
    if (parsed) {
      return parsed;
    }
  }

  const configObj = asObject(params.integration.config);
  const intakeConfigObj = asObject(params.integration.intakeConfig);
  const owner = intakeConfigObj.owner ?? configObj.owner;
  const repo = intakeConfigObj.repo ?? configObj.repo;
  if (
    typeof owner === "string" &&
    owner.trim().length > 0 &&
    typeof repo === "string" &&
    repo.trim().length > 0 &&
    payloadIssueNumber &&
    Number.isInteger(payloadIssueNumber) &&
    payloadIssueNumber > 0
  ) {
    return {
      owner: owner.trim(),
      repo: repo.trim(),
      issueNumber: payloadIssueNumber,
    };
  }

  return null;
}

const feedbackOptInSchema = z
  .object({
    feedback: z
      .object({
        github: z
          .object({
            postTaskStatusComments: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

async function shouldPostGithubTaskCommentsForRepo(repoRoot: string): Promise<boolean> {
  const absRepoRoot = path.resolve(expandHomeDir(repoRoot));
  const absConfig = path.join(absRepoRoot, ".flux", "golden-path.yaml");
  if (!existsSync(absConfig)) {
    return false;
  }
  try {
    const text = await readFile(absConfig, "utf-8");
    const raw = YAML.parse(text) as unknown;
    const parsed = feedbackOptInSchema.safeParse(raw);
    if (!parsed.success) {
      return false;
    }
    return parsed.data.feedback?.github?.postTaskStatusComments === true;
  } catch {
    // Fail closed: never post to GitHub on config read/parse errors.
    return false;
  }
}

function buildTaskStatusComment(params: {
  row: FeedbackEventRow;
  task: TaskRow | null;
  payload: Record<string, unknown>;
}): string {
  const toStatus =
    typeof params.payload.status === "string" ? params.payload.status : params.row.eventType;
  const fromStatus =
    typeof params.payload.fromStatus === "string" && params.payload.fromStatus.trim().length > 0
      ? params.payload.fromStatus.trim()
      : "unknown";
  const output =
    typeof params.payload.output === "string" && params.payload.output.trim().length > 0
      ? params.payload.output.trim()
      : "";
  const taskLabel = params.task?.goal?.trim()
    ? params.task.goal.trim()
    : (params.row.taskId ?? "task");
  const lines = [
    "Squads status update",
    `- Task: ${taskLabel}`,
    `- Transition: ${fromStatus} -> ${toStatus}`,
    `- Feedback event: ${params.row._id}`,
  ];
  if (output) {
    const maxOutputChars = 1500;
    const clipped =
      output.length > maxOutputChars ? `${output.slice(0, maxOutputChars)}...` : output;
    lines.push("", "Output:", "```text", clipped, "```");
  }
  return lines.join("\n");
}

function shouldPostTaskStatusComment(payload: Record<string, unknown>): boolean {
  const toStatus = typeof payload.status === "string" ? payload.status.trim() : "";
  // Avoid noisy "started" spam; the useful payload is typically on done/failed/review/blocked.
  return toStatus !== "doing";
}

export function createIntegrationFeedbackWorker(
  client: ConvexClient,
  opts: { pollEveryMs?: number; batchLimit?: number } = {},
): TaskSource {
  let timer: ReturnType<typeof setInterval> | null = null;
  const pollEveryMs = opts.pollEveryMs ?? 60_000;
  const batchLimit = opts.batchLimit ?? 100;
  const maxBackoffMs = 5 * 60_000;
  let backoff: BackoffState = { failures: 0, backoffUntil: 0 };
  const githubCapability = createGitHubCapabilityProvider();

  async function poll() {
    const now = Date.now();
    if (now < backoff.backoffUntil) {
      return;
    }
    try {
      const rows = (await client.query(api.integration_feedback.listPending, {
        limit: batchLimit,
      })) as FeedbackEventRow[];

      let sent = 0;
      let failed = 0;
      let deadLettered = 0;

      for (const row of rows) {
        const integration = (await client.query(api.integrations.get, {
          id: row.integrationId,
        })) as IntegrationRow | null;

        if (integration?.enabled && integration.type === "github") {
          const payload = parsePayload(row.payloadJson);
          if (row.topic === "task" && row.eventType === "task_status_changed") {
            const task = row.taskId
              ? ((await client.query(api.tasks.get, { id: row.taskId })) as TaskRow | null)
              : null;
            const issueRef = resolveIssueRef({ payload, task, integration });
            if (issueRef) {
              if (shouldPostTaskStatusComment(payload)) {
                const repoContext = row.taskId
                  ? ((await client.query(api.tasks.getExecutionRepoContext, {
                      taskId: row.taskId,
                    })) as ExecutionRepoContext | null)
                  : null;
                const repoPath =
                  (repoContext?.repoPath && repoContext.repoPath.trim().length > 0
                    ? repoContext.repoPath.trim()
                    : undefined) ?? resolveRepoPathFromIntegration(integration);

                const allowPost = repoPath
                  ? await shouldPostGithubTaskCommentsForRepo(repoPath)
                  : false;
                if (allowPost) {
                  const body = buildTaskStatusComment({ row, task, payload });
                  try {
                    await githubCapability.postIssueComment({
                      owner: issueRef.owner,
                      repo: issueRef.repo,
                      issueNumber: issueRef.issueNumber,
                      body,
                      auth: resolveGitHubAuth(integration),
                      meta: {
                        requestId: `feedback:${row._id}`,
                        idempotencyKey: `feedback:${row._id}`,
                      },
                    });
                  } catch (error: unknown) {
                    const errorText = error instanceof Error ? error.message : String(error);
                    const failedResult = (await client.mutation(
                      api.integration_feedback.markDeliveryFailure,
                      {
                        id: row._id,
                        error: errorText,
                      },
                    )) as { status: string };
                    if (failedResult.status === "dead_letter") {
                      deadLettered += 1;
                    } else {
                      failed += 1;
                    }
                    continue;
                  }
                } else {
                  log.debug(
                    `skipping github feedback post (repo has not opted in via .flux): integration_id=${integration._id} event_id=${row._id}`,
                  );
                }
              }
            }
          }
        }

        const result = (await client.mutation(api.integration_feedback.processById, {
          id: row._id,
        })) as { status: string };
        if (result.status === "sent") {
          sent += 1;
        } else if (result.status === "dead_letter") {
          deadLettered += 1;
        } else if (result.status === "failed") {
          failed += 1;
        }
      }

      backoff = { failures: 0, backoffUntil: 0 };
      if (rows.length > 0) {
        log.debug(
          `processed ${rows.length} feedback event(s): sent=${sent} failed=${failed} deadLettered=${deadLettered} provider=${githubCapability.providerName}`,
        );
      }
    } catch (error: unknown) {
      const errorText = error instanceof Error ? error.message : String(error);
      const failures = backoff.failures + 1;
      const backoffMs = Math.min(maxBackoffMs, pollEveryMs * 2 ** (failures - 1));
      backoff = {
        failures,
        backoffUntil: Date.now() + backoffMs,
      };
      log.warn(
        `feedback processing failed (${failures}): ${errorText}; backoff ${Math.round(backoffMs / 1000)}s`,
      );
    }
  }

  return {
    id: "integration-feedback",

    async start(_ctx: RuntimeContext) {
      await poll();
      timer = setInterval(() => void poll(), pollEveryMs);
      log.info(`integration feedback worker started (every ${Math.round(pollEveryMs / 1000)}s)`);
    },

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await githubCapability.stop?.();
      backoff = { failures: 0, backoffUntil: 0 };
      log.info("integration feedback worker stopped");
    },
  };
}
