/**
 * Claude CLI execution backend.
 *
 * Spawns the `claude` CLI binary as a subprocess to execute tasks.
 * This is the simplest backend — it passes the prompt via `-p` flag,
 * captures JSON output, and extracts the result.
 *
 * Binary resolution order:
 *   1. CLAUDE_BIN env var
 *   2. Local node_modules/.bin/claude
 *   3. ~/.local/bin/claude
 *   4. /usr/local/bin/claude
 *   5. /opt/homebrew/bin/claude
 *   6. Falls back to bare "claude" (relies on PATH)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import type {
  RunnerExecutionBackend,
  RunnerExecutionRequest,
  RunnerExecutionResult,
} from "./execution.js";
import { normalizeExecutionBackend } from "./execution.js";

/**
 * Parses Claude CLI stdout, which may be JSON-wrapped.
 * Tries to extract `result` or `response` from a JSON envelope;
 * falls back to extracting the first JSON object or returning raw text.
 */
export function parseClaudeCliOutput(stdout: string): string {
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

/** Finds the claude binary by checking known installation paths. */
function resolveClaudeCommand(): { command: string; prefixArgs: string[] } {
  const envOverride = process.env.CLAUDE_BIN?.trim();
  const candidates = [
    envOverride,
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

/** Assembles the CLI arguments for the claude command. */
function buildClaudeArgs(opts: {
  prompt: string;
  model?: string;
  allowedTools?: string[];
  outputFormat?: string;
}): string[] {
  const args = ["-p", opts.prompt];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  args.push("--output-format", opts.outputFormat ?? "json");
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }
  return args;
}

export class ClaudeCliExecutionBackend implements RunnerExecutionBackend {
  readonly id = "claude-cli";

  canExecute(backend: string): boolean {
    return normalizeExecutionBackend(backend) === "claude-cli";
  }

  async execute(request: RunnerExecutionRequest): Promise<RunnerExecutionResult> {
    const bin = resolveClaudeCommand();
    const model = request.packet.execution?.model?.trim() || undefined;
    const allowedTools = request.packet.execution?.allowedTools;

    const command = bin.command;
    const args = [
      ...bin.prefixArgs,
      ...buildClaudeArgs({
        prompt: request.prompt,
        model,
        allowedTools,
        outputFormat: "json",
      }),
    ];

    const start = Date.now();
    // Whitelist env vars — explicitly exclude secrets (FLUX_TOKEN, OPENCLAW_*)
    const allowedEnv: Record<string, string> = {};
    const envKeys = ["PATH", "HOME", "TMPDIR", "LANG", "TERM", "CLAUDE_BIN"] as const;
    for (const key of envKeys) {
      const val = process.env[key];
      if (val !== undefined) allowedEnv[key] = val;
    }

    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: allowedEnv,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let finished = false;
    const killChild = () => {
      if (finished) return;
      finished = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };

    request.abortSignal.addEventListener("abort", killChild, { once: true });

    const exitCode: number | null = await new Promise((resolve) => {
      child.on("close", (code) => resolve(code ?? null));
      child.on("error", () => resolve(1));
    });
    finished = true;
    request.abortSignal.removeEventListener("abort", killChild);

    const durationMs = Math.max(0, Date.now() - start);
    const output = stdout.trim().length > 0 ? parseClaudeCliOutput(stdout) : "";

    if (request.abortSignal.aborted) {
      return {
        status: "cancelled",
        output: "Cancelled by user request",
        durationMs,
      };
    }

    if (exitCode !== 0) {
      const details = stderr.trim() || stdout.trim() || `claude exited ${String(exitCode)}`;
      return {
        status: "failed",
        output: `claude-cli failed: ${details}`,
        durationMs,
      };
    }

    return {
      status: "done",
      output: output.trim().length > 0 ? output : "(empty response)",
      durationMs,
      model: model || "claude-cli",
    };
  }
}
