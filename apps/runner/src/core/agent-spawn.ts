// Shared helpers for spawning openclaw agent subprocesses.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import type { RepoContext } from "./types.js";
import { resolveCliBackendConfig } from "../../agents/cli-backends.js";
import { loadConfig } from "../../config/io.js";

// Resolve the openclaw binary — check local project first, then PATH
export function resolveCliBin(): { command: string; prefixArgs: string[] } {
  const cwd = process.cwd();

  // 1. Local project entry point (dev mode via pnpm openclaw)
  const localEntry = resolve(cwd, "openclaw.mjs");
  if (existsSync(localEntry)) {
    return { command: process.execPath, prefixArgs: [localEntry] };
  }

  // 2. Built dist entry
  const distEntry = resolve(cwd, "dist/entry.js");
  if (existsSync(distEntry)) {
    return { command: process.execPath, prefixArgs: [distEntry] };
  }

  // 3. Global openclaw binary
  return { command: "openclaw", prefixArgs: [] };
}

// Resolve the Claude Code binary — assumes `claude` is on PATH
export function resolveClaudeBin(): { command: string; prefixArgs: string[] } {
  const envOverride = process.env.CLAUDE_BIN?.trim();
  let configuredCommand: string | undefined;
  try {
    const cfg = loadConfig();
    configuredCommand = resolveCliBackendConfig("claude-cli", cfg)?.config.command?.trim();
  } catch {
    configuredCommand = undefined;
  }
  const candidates = [
    envOverride,
    configuredCommand,
    resolve(process.cwd(), "node_modules/.bin/claude"),
    resolve(os.homedir(), ".local/bin/claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { command: candidate, prefixArgs: [] };
    }
  }

  return { command: "claude", prefixArgs: [] };
}

// Build args for spawning `claude` in non-interactive mode
export function buildClaudeArgs(opts: {
  prompt: string;
  model?: string;
  allowedTools?: string;
  outputFormat?: string;
}): string[] {
  const args = ["-p", opts.prompt];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  args.push("--output-format", opts.outputFormat ?? "json");
  if (opts.allowedTools) {
    args.push("--allowedTools", opts.allowedTools);
  }
  return args;
}

// Load source-specific preamble (repo-relative path for dev/tests).
export async function loadSourcePreamble(source: string): Promise<string | null> {
  const preamblePath = resolve(
    process.cwd(),
    `apps/runner/src/sources/${source}/preamble.md`,
  );
  try {
    return await readFile(preamblePath, "utf-8");
  } catch {
    return null;
  }
}

// Replace all {KEY} placeholders in a template with values from vars + repo context
export function buildPromptFromTemplate(
  template: string,
  vars: Record<string, string>,
  repo: RepoContext = {},
): string {
  // Build project fields table from repo context
  let projectFieldsTable = "_No project fields configured._";
  if (repo.fields) {
    const lines: string[] = [];
    for (const [name, field] of Object.entries(repo.fields)) {
      lines.push(`- **${name}**: ${Object.keys(field.options).join(", ")}`);
    }
    if (lines.length > 0) {
      projectFieldsTable = lines.join("\n");
    }
  }

  // Repo-level vars
  const allVars: Record<string, string> = {
    OWNER: repo.owner ?? "",
    REPO: repo.repo ?? "",
    PROJECT_NUMBER: String(repo.projectNumber ?? ""),
    PROJECT_FIELDS_TABLE: projectFieldsTable,
    // Backwards compat
    ISSUE_NUMBER: vars.issueNumber ?? "",
    TITLE: vars.title ?? "",
    // Spread all task-level vars (overrides above if same key)
    ...vars,
  };

  let result = template;
  for (const [key, value] of Object.entries(allVars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

// Build the full prompt from an execution skill's promptTemplate string (no filesystem lookup)
export async function buildPromptFromSkillTemplate(
  promptTemplate: string,
  source: string | undefined,
  vars: Record<string, string>,
  repo: RepoContext = {},
): Promise<string> {
  const parts: string[] = [];

  if (source) {
    const preamble = await loadSourcePreamble(source);
    if (preamble) {
      parts.push(buildPromptFromTemplate(preamble, vars, repo));
    }
  }

  if (vars.AGENT_PERSONA) {
    parts.push(vars.AGENT_PERSONA);
  }

  parts.push(buildPromptFromTemplate(promptTemplate, vars, repo));

  return parts.join("\n\n---\n\n");
}
