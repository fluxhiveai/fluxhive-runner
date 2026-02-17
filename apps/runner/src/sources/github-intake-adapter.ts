import type { ConvexClient } from "convex/browser";
import type { IntegrationConfig } from "../core/types.js";
import type { IntegrationIntakeAdapter, IntegrationRow } from "./integration-adapter.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveUserPath } from "../../utils.js";
import { createGitHubCapabilityProvider } from "../capabilities/github/provider-factory.js";
import { GitHubCapabilityError, type GitHubAuth } from "../capabilities/github/types.js";
import { api } from "../core/convex-client.js";
import { loadGoldenPathConfig } from "../core/golden-path.js";

type ResolvedGitHubIntegration = {
  config: IntegrationConfig;
  token?: string;
};

type IssueCheckpoint = {
  updatedAtMs: number;
  issueNumber: number;
};

const log = createSubsystemLogger("flux").child("integration-intake-github");

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

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

function resolveGitHubConfig(integration: IntegrationRow): ResolvedGitHubIntegration | null {
  const configObj = asObject(integration.config);
  const intakeObj = asObject(integration.intakeConfig);
  const settings = parseSettingsMap(integration.settings);
  const owner = parseTrimmedString(settings.owner ?? intakeObj.owner ?? configObj.owner);
  const repo = parseTrimmedString(settings.repo ?? intakeObj.repo ?? configObj.repo);
  const projectNumber = parseOptionalInteger(
    settings.projectNumber ?? intakeObj.projectNumber ?? configObj.projectNumber,
  );
  const tokenRaw =
    settings.token ??
    intakeObj.token ??
    configObj.token ??
    resolveTokenFromSecretRef(integration.secretRef);
  const token =
    typeof tokenRaw === "string" && tokenRaw.trim().length > 0 ? tokenRaw.trim() : undefined;
  const repoPath = parseTrimmedString(
    settings.repoPath ??
      settings.localRepoPath ??
      settings.workspacePath ??
      intakeObj.repoPath ??
      intakeObj.localRepoPath ??
      intakeObj.workspacePath ??
      configObj.repoPath ??
      configObj.localRepoPath ??
      configObj.workspacePath,
  );

  if (!owner || !repo || projectNumber === undefined) {
    return null;
  }

  return {
    config: {
      owner,
      repo,
      ...(repoPath ? { repoPath } : {}),
      projectNumber,
      projectId:
        parseTrimmedString(settings.projectId ?? intakeObj.projectId ?? configObj.projectId) ??
        undefined,
      pollIntervalSeconds:
        typeof integration.pollIntervalSeconds === "number"
          ? integration.pollIntervalSeconds
          : (parseOptionalInteger(
              settings.pollIntervalSeconds ??
                intakeObj.pollIntervalSeconds ??
                configObj.pollIntervalSeconds,
            ) ?? 60),
      stages:
        typeof intakeObj.stages === "object" && intakeObj.stages !== null
          ? (intakeObj.stages as IntegrationConfig["stages"])
          : typeof configObj.stages === "object" && configObj.stages !== null
            ? (configObj.stages as IntegrationConfig["stages"])
            : undefined,
      fields:
        typeof intakeObj.fields === "object" && intakeObj.fields !== null
          ? (intakeObj.fields as IntegrationConfig["fields"])
          : typeof configObj.fields === "object" && configObj.fields !== null
            ? (configObj.fields as IntegrationConfig["fields"])
            : undefined,
    },
    token,
  };
}

function parseIssueCheckpointFromCursor(raw: string | undefined): IssueCheckpoint | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const checkpoint = parsed as Record<string, unknown>;
    const updatedAtMs = checkpoint.updatedAtMs;
    const issueNumber = checkpoint.issueNumber;
    if (
      typeof updatedAtMs === "number" &&
      Number.isFinite(updatedAtMs) &&
      typeof issueNumber === "number" &&
      Number.isInteger(issueNumber) &&
      issueNumber > 0
    ) {
      return { updatedAtMs, issueNumber };
    }
  } catch {
    return null;
  }
  return null;
}

function toIssueCheckpoint(issue: { number: number; updatedAt: string }): IssueCheckpoint | null {
  const updatedAtMs = Date.parse(issue.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return null;
  }
  return {
    updatedAtMs,
    issueNumber: issue.number,
  };
}

function compareIssueCheckpoint(a: IssueCheckpoint, b: IssueCheckpoint): number {
  if (a.updatedAtMs !== b.updatedAtMs) {
    return a.updatedAtMs - b.updatedAtMs;
  }
  return a.issueNumber - b.issueNumber;
}

function serializeIssueCheckpoint(checkpoint: IssueCheckpoint): string {
  return JSON.stringify(checkpoint);
}

function formatIssueCheckpoint(checkpoint: IssueCheckpoint | null): string {
  if (!checkpoint) {
    return "none";
  }
  const iso = new Date(checkpoint.updatedAtMs).toISOString();
  return `${iso}#${checkpoint.issueNumber}`;
}

function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

async function resolvePollStatusesFromGoldenPath(
  repoPath: string | undefined,
): Promise<string[] | null> {
  if (!repoPath) {
    return null;
  }
  const absRepoPath = resolveUserPath(repoPath);
  try {
    const config = await loadGoldenPathConfig(absRepoPath);
    if (!config) {
      return null;
    }
    const names = config.lifecycle
      .flatMap((stage) => stage.statuses)
      .filter((status) => status.id !== null)
      .map((status) => (typeof status.name === "string" ? status.name.trim() : ""))
      .filter((name) => name.length > 0);
    return dedupePreservingOrder(names);
  } catch (error) {
    log.warn(
      `failed to load golden-path.yaml from repoPath=${repoPath} (polling will fall back to integration config): ${String(error)}`,
    );
    return null;
  }
}

export function createGitHubIntakeAdapter(): IntegrationIntakeAdapter {
  const capability = createGitHubCapabilityProvider();

  return {
    type: "github",
    async pollIntegration({
      integration,
      client,
    }: {
      integration: IntegrationRow;
      client: ConvexClient;
    }) {
      const resolved = resolveGitHubConfig(integration);
      if (!resolved) {
        log.warn(
          `integration ${integration._id} (${integration.name}) missing required github config (owner/repo/projectNumber)`,
        );
        return;
      }
      const config = resolved.config;

      const goldenPathStatuses = await resolvePollStatusesFromGoldenPath(config.repoPath);
      const activeStages = goldenPathStatuses
        ? goldenPathStatuses
        : Object.entries(config.stages ?? {})
            .filter(([, stage]) => stage.agent !== null)
            .map(([name]) => name);
      if (activeStages.length === 0) {
        log.debug(
          `integration ${integration._id} has no pollable statuses configured (missing .flux/golden-path.yaml and no integration stages)`,
        );
        return;
      }

      const auth: GitHubAuth = {
        kind: "token",
        ...(resolved.token ? { token: resolved.token } : {}),
      };

      const operationStartedAt = Date.now();
      let issues: Array<{
        number: number;
        title: string;
        projectStatus: string;
        updatedAt: string;
      }>;
      try {
        const result = await capability.listProjectIssuesByStatus({
          config,
          statuses: activeStages,
          auth,
          meta: {
            requestId: `integration:${integration._id}:poll:${operationStartedAt}`,
          },
        });
        issues = result.issues;
        log.info(
          `github capability success provider_name=${capability.providerName} provider_operation=listProjectIssuesByStatus provider_operation_duration_ms=${Date.now() - operationStartedAt} provider_attempt_count=1 integration_id=${integration._id} issues=${issues.length}`,
        );
      } catch (error: unknown) {
        const category =
          error instanceof GitHubCapabilityError ? error.category : ("unknown" as const);
        log.warn(
          `github capability failure provider_name=${capability.providerName} provider_operation=listProjectIssuesByStatus provider_operation_duration_ms=${Date.now() - operationStartedAt} provider_attempt_count=1 provider_error_category=${category} integration_id=${integration._id}: ${String(error)}`,
        );
        throw error;
      }

      // One issue per poll: select the oldest eligible issue after intake cursor.
      const cursor = parseIssueCheckpointFromCursor(
        integration.intakeCursor ?? integration.watcherCursor,
      );
      const entries = issues
        .map((issue) => {
          const checkpoint = toIssueCheckpoint(issue);
          return checkpoint ? { issue, checkpoint } : null;
        })
        .filter((entry): entry is { issue: (typeof issues)[number]; checkpoint: IssueCheckpoint } =>
          Boolean(entry),
        )
        .toSorted((a, b) => compareIssueCheckpoint(a.checkpoint, b.checkpoint));
      const candidates = entries.filter((entry) =>
        cursor ? compareIssueCheckpoint(entry.checkpoint, cursor) > 0 : true,
      );

      if (issues.length > 0) {
        const oldest = entries[0]?.checkpoint ?? null;
        const newest = entries.at(-1)?.checkpoint ?? null;
        log.info(
          `github intake decision integration_id=${integration._id} cursor=${formatIssueCheckpoint(cursor)} issues=${issues.length} candidates=${candidates.length} oldest=${formatIssueCheckpoint(oldest)} newest=${formatIssueCheckpoint(newest)}`,
        );
      }

      const selected = candidates[0];
      if (!selected) {
        if (issues.length > 0) {
          const sample = entries
            .slice(0, 3)
            .map(
              ({ issue, checkpoint }) =>
                `#${issue.number}@${new Date(checkpoint.updatedAtMs).toISOString()} status=${issue.projectStatus}`,
            )
            .join(", ");
          log.info(
            `github intake skipped integration_id=${integration._id} (no issue checkpoint newer than cursor=${formatIssueCheckpoint(cursor)}). sample=[${sample}]`,
          );
        }
        return;
      }

      const issue = selected.issue;
      const checkpoint = selected.checkpoint;
      const ingestResult = (await client.mutation(api.intake_events.ingest, {
        integrationId: integration._id,
        ...(integration.streamId ? { streamId: integration.streamId } : {}),
        resourceType: "issue",
        resourceId: `${config.owner}/${config.repo}#${issue.number}`,
        resourceUpdatedAt: issue.updatedAt,
        externalStatus: issue.projectStatus,
        payloadJson: JSON.stringify({
          provider: "github",
          owner: config.owner,
          repo: config.repo,
          ...(config.repoPath ? { repoPath: config.repoPath } : {}),
          issueNumber: issue.number,
          title: issue.title,
          stage: issue.projectStatus,
        }),
        contextJson: JSON.stringify({
          source: {
            provider: "github",
            owner: config.owner,
            repo: config.repo,
            ...(config.repoPath ? { repoPath: config.repoPath } : {}),
          },
          entity: {
            type: "issue",
            number: issue.number,
            title: issue.title,
            stage: issue.projectStatus,
            updatedAt: issue.updatedAt,
          },
        }),
        // Stage selection is status-driven; do not incorporate `updatedAt` because our own feedback
        // comments can bump timestamps and cause repeated re-routing for the same status.
        idempotencyKey: `github:${issue.number}:${issue.projectStatus}`,
        autoRoute: false,
      })) as { eventId?: string; deduped?: boolean; status?: string; runId?: string };

      if (ingestResult?.eventId) {
        log.info(
          `github intake ingested integration_id=${integration._id} issue=#${issue.number} status=${issue.projectStatus} updatedAt=${issue.updatedAt} eventId=${ingestResult.eventId} deduped=${ingestResult.deduped === true} intakeStatus=${ingestResult.status ?? "unknown"} runId=${ingestResult.runId ?? ""}`,
        );
        const routed = (await client.action(api.intake_events.routeAgentic, {
          intakeEventId: ingestResult.eventId,
        })) as { status?: string; runId?: string };
        log.info(
          `github intake routed integration_id=${integration._id} eventId=${ingestResult.eventId} status=${routed?.status ?? "unknown"} runId=${routed?.runId ?? ""}`,
        );
      }

      await client.mutation(api.integrations.update, {
        id: integration._id,
        intakeCursor: serializeIssueCheckpoint(checkpoint),
      });

      log.info(
        `github intake cursor advanced integration_id=${integration._id} cursor=${formatIssueCheckpoint(checkpoint)}`,
      );
    },
    stop() {
      void capability.stop?.();
    },
  };
}
