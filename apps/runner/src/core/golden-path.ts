import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { RepoContext, Task } from "./types.js";
import { buildPromptFromTemplate } from "./agent-spawn.js";

type GoldenPathStatus = {
  name?: string;
  id?: string | null;
};

type GoldenPathStage = {
  key: string;
  statuses: GoldenPathStatus[];
  skill: string;
};

export type GoldenPathConfig = {
  contractVersion: number;
  resourceType?: string;
  globalContext?: {
    files: string[];
    onMissingFile?: "fail" | "skip";
  };
  lifecycle: GoldenPathStage[];
};

export type GoldenPathStageResolution = {
  stageKey: string;
  skillRelPath: string;
  globalContextFiles: string[];
};

const goldenPathStatusSchema = z.object({
  name: z.string().optional(),
  id: z.union([z.string(), z.null()]).optional(),
});

const goldenPathStageSchema = z.object({
  key: z.string(),
  statuses: z.array(goldenPathStatusSchema),
  skill: z.string(),
});

const onMissingFileSchema = z.enum(["fail", "skip"]);

const goldenPathConfigSchema = z.object({
  contractVersion: z.number().int().positive(),
  resourceType: z.string().optional(),
  globalContext: z
    .object({
      files: z.array(z.string()),
      onMissingFile: onMissingFileSchema.optional(),
    })
    .optional(),
  lifecycle: z.array(goldenPathStageSchema),
});

function isUnderDir(absPath: string, absDir: string): boolean {
  const rel = path.relative(absDir, absPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveRepoFile(repoRoot: string, relPath: string): string {
  // Treat YAML paths as repo-relative. (Even if they begin with "./" or ".flux/...".)
  const abs = path.resolve(repoRoot, relPath);
  const rel = path.relative(repoRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`golden-path path escapes repo root: ${relPath}`);
  }
  return abs;
}

function normalizeExternalStatus(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseTaskJson(task: Task): {
  intake?: Record<string, unknown>;
  node?: Record<string, unknown>;
} {
  try {
    const parsed = JSON.parse(task.input) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const obj = parsed as Record<string, unknown>;
    const intake =
      obj.intake && typeof obj.intake === "object" && !Array.isArray(obj.intake)
        ? (obj.intake as Record<string, unknown>)
        : undefined;
    const node =
      obj.node && typeof obj.node === "object" && !Array.isArray(obj.node)
        ? (obj.node as Record<string, unknown>)
        : undefined;
    return { intake, node };
  } catch {
    return {};
  }
}

function extractIssueNumberFromResourceId(resourceId: string | undefined): string {
  if (!resourceId) {
    return "";
  }
  const match = /#(\d+)\b/.exec(resourceId);
  return match?.[1] ?? "";
}

function buildGoldenPathVars(args: {
  task: Task;
  repo: RepoContext;
  stageStatus: string;
  nodeKey?: string;
}): Record<string, string> {
  const { intake, node } = parseTaskJson(args.task);
  const intakeJson = intake ? JSON.stringify(intake, null, 2) : "";
  const nodeJson = node ? JSON.stringify(node, null, 2) : "";

  const resourceId = typeof intake?.resourceId === "string" ? intake.resourceId : undefined;
  const issueNumber = extractIssueNumberFromResourceId(resourceId);

  return {
    RUN_ID: args.task.runId ?? "",
    TASK_ID: args.task._id,
    TASK_GOAL: args.task.goal,
    PLAYBOOK_SLUG: args.task.workflow ?? "",
    PLAYBOOK_NODE_KEY: args.nodeKey ?? "",
    OWNER: args.repo.owner ?? "",
    REPO: args.repo.repo ?? "",
    REPO_PATH: args.repo.repoPath ?? "",
    NOW_ISO: new Date().toISOString(),

    ISSUE_NUMBER: issueNumber,
    ISSUE_TITLE: "",
    ISSUE_STATUS: args.stageStatus,
    ISSUE_STATE: "",
    ISSUE_URL: "",
    ISSUE_BODY: "",
    ISSUE_UPDATED_AT: typeof intake?.resourceUpdatedAt === "string" ? intake.resourceUpdatedAt : "",
    ISSUE_LABELS: "",
    ISSUE_ASSIGNEES: "",

    ISSUE_JSON: "",
    INTAKE_JSON: intakeJson,
    NODE_JSON: nodeJson,
  };
}

export async function loadGoldenPathConfig(repoRoot: string): Promise<GoldenPathConfig | null> {
  const abs = path.join(repoRoot, ".flux", "golden-path.yaml");
  if (!existsSync(abs)) {
    return null;
  }
  const text = await readFile(abs, "utf-8");
  const raw = YAML.parse(text) as unknown;
  return goldenPathConfigSchema.parse(raw);
}

export function resolveGoldenPathStage(args: {
  config: GoldenPathConfig;
  externalStatus: string;
}): GoldenPathStageResolution | null {
  const external = normalizeExternalStatus(args.externalStatus);
  if (!external) {
    return null;
  }

  // 1) Prefer status ID matches when present (external status can be an ID string).
  for (const stage of args.config.lifecycle) {
    for (const status of stage.statuses) {
      const id = normalizeExternalStatus(status.id);
      if (id && id === external) {
        return {
          stageKey: stage.key,
          skillRelPath: stage.skill,
          globalContextFiles: args.config.globalContext?.files ?? [],
        };
      }
    }
  }

  // 2) Fall back to status name matches.
  for (const stage of args.config.lifecycle) {
    for (const status of stage.statuses) {
      const name = normalizeExternalStatus(status.name);
      if (name && name === external) {
        return {
          stageKey: stage.key,
          skillRelPath: stage.skill,
          globalContextFiles: args.config.globalContext?.files ?? [],
        };
      }
    }
  }

  // 3) Looser match: case-insensitive name compare for common user input drift.
  const externalLower = external.toLowerCase();
  for (const stage of args.config.lifecycle) {
    for (const status of stage.statuses) {
      const name = normalizeExternalStatus(status.name);
      if (name && name.toLowerCase() === externalLower) {
        return {
          stageKey: stage.key,
          skillRelPath: stage.skill,
          globalContextFiles: args.config.globalContext?.files ?? [],
        };
      }
    }
  }

  return null;
}

export async function buildGoldenPathPrompt(args: {
  task: Task;
  repoRoot: string;
  repo: RepoContext;
  externalStatus: string;
  nodeKey?: string;
}): Promise<
  | { kind: "mapped"; stageKey: string; prompt: string; skillRelPath: string }
  | { kind: "noop"; reason: string }
  | { kind: "missing" }
> {
  const config = await loadGoldenPathConfig(args.repoRoot);
  if (!config) {
    return { kind: "missing" };
  }

  const resolution = resolveGoldenPathStage({ config, externalStatus: args.externalStatus });
  if (!resolution) {
    return {
      kind: "noop",
      reason: `No golden-path lifecycle mapping found for externalStatus="${args.externalStatus}".`,
    };
  }

  const onMissing = config.globalContext?.onMissingFile ?? "fail";
  const vars = buildGoldenPathVars({
    task: args.task,
    repo: args.repo,
    stageStatus: args.externalStatus,
    nodeKey: args.nodeKey,
  });

  const parts: string[] = [];

  for (const relPath of resolution.globalContextFiles) {
    const absPath = resolveRepoFile(args.repoRoot, relPath);
    if (!existsSync(absPath)) {
      if (onMissing === "skip") {
        continue;
      }
      throw new Error(`golden-path globalContext file missing: ${relPath}`);
    }
    const content = await readFile(absPath, "utf-8");
    parts.push(buildPromptFromTemplate(content, vars, args.repo));
  }

  const absSkillPath = resolveRepoFile(args.repoRoot, resolution.skillRelPath);
  const absSkillsDir = path.join(args.repoRoot, ".flux", "skills");
  if (!isUnderDir(absSkillPath, absSkillsDir)) {
    throw new Error(
      `golden-path skill must resolve under .flux/skills/: ${resolution.skillRelPath}`,
    );
  }
  if (!existsSync(absSkillPath)) {
    throw new Error(`golden-path skill file missing: ${resolution.skillRelPath}`);
  }
  const skillContent = await readFile(absSkillPath, "utf-8");
  parts.push(buildPromptFromTemplate(skillContent, vars, args.repo));

  return {
    kind: "mapped",
    stageKey: resolution.stageKey,
    skillRelPath: resolution.skillRelPath,
    prompt: parts.join("\n\n---\n\n"),
  };
}
