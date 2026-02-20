/**
 * PI (Personal Intelligence) execution backend.
 *
 * Runs tasks using the pi-coding-agent library for local LLM inference.
 * The PI backend:
 *   - Uses a model registry (models.json) and auth storage (auth.json)
 *     located in the agent directory (~/.flux/pi-agent by default)
 *   - Supports any provider/model configured in the registry
 *   - Validates output against JSON Schema when execution.outputSchemaJson is set
 *   - Respects task timeouts and abort signals
 *   - Streams text deltas for progressive output capture
 */
import os from "node:os";
import path from "node:path";
import { access, constants } from "node:fs/promises";
import { Ajv } from "ajv";
import {
  AuthStorage,
  ModelRegistry,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
  RunnerExecutionBackend,
  RunnerExecutionRequest,
  RunnerExecutionResult,
} from "./execution.js";
import { normalizeExecutionBackend } from "./execution.js";

const ajv = new Ajv({
  allErrors: true,
  strict: false,
});

type ParsedModelRef = {
  provider: string;
  model: string;
};

/** Reads the task timeout from the packet (execution or policy), converting seconds to ms. */
function resolveTaskTimeoutMs(request: RunnerExecutionRequest): number | null {
  const fromExecution =
    typeof request.packet.execution?.timeoutSec === "number" &&
    Number.isFinite(request.packet.execution.timeoutSec)
      ? request.packet.execution.timeoutSec
      : null;
  const fromPolicy =
    typeof request.packet.policy?.taskTimeoutSeconds === "number" &&
    Number.isFinite(request.packet.policy.taskTimeoutSeconds)
      ? request.packet.policy.taskTimeoutSeconds
      : null;
  const seconds = fromExecution ?? fromPolicy;
  if (seconds === null || seconds <= 0) return null;
  return Math.floor(seconds * 1000);
}

/** Parses a "provider/model" string into its components. */
function parseModelRef(raw: string): ParsedModelRef | null {
  const normalized = raw.trim();
  const slash = normalized.indexOf("/");
  if (slash <= 0 || slash === normalized.length - 1) {
    return null;
  }
  return {
    provider: normalized.slice(0, slash),
    model: normalized.slice(slash + 1),
  };
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.role === "assistant" && Array.isArray(row.content);
}

function extractAssistantText(message: AssistantMessage | null): string {
  if (!message) return "";
  const chunks: string[] = [];
  for (const content of message.content) {
    if (content.type === "text" && typeof content.text === "string") {
      chunks.push(content.text);
    }
  }
  return chunks.join("").trim();
}

function summarizeAjvErrors(errors: unknown): string {
  if (!Array.isArray(errors) || errors.length === 0) return "unknown schema validation error";
  const messages = errors
    .slice(0, 3)
    .map((err) => {
      if (!err || typeof err !== "object") return null;
      const row = err as Record<string, unknown>;
      const pathRaw =
        typeof row.instancePath === "string" && row.instancePath.length > 0
          ? row.instancePath
          : "/";
      const msg =
        typeof row.message === "string" && row.message.length > 0
          ? row.message
          : "invalid";
      return `${pathRaw} ${msg}`;
    })
    .filter((line): line is string => Boolean(line));
  return messages.join("; ") || "unknown schema validation error";
}

/**
 * Validates the output text against a JSON Schema.
 * Returns null if valid, or a human-readable error string if validation fails.
 */
function validateOutputSchema(
  outputSchemaJson: string,
  outputText: string,
): string | null {
  let schema: unknown;
  try {
    schema = JSON.parse(outputSchemaJson);
  } catch {
    return "packet execution.outputSchemaJson is not valid JSON";
  }

  const validate = ajv.compile(schema as Record<string, unknown>);

  let parsedOutput: unknown;
  try {
    parsedOutput = JSON.parse(outputText);
  } catch {
    return "output is not valid JSON";
  }

  const valid = validate(parsedOutput);
  if (valid) return null;
  return summarizeAjvErrors(validate.errors);
}

export type PiExecutionBackendOptions = {
  agentDir?: string;
};

export class PiExecutionBackend implements RunnerExecutionBackend {
  readonly id = "pi";
  private readonly agentDir: string;

  constructor(opts: PiExecutionBackendOptions = {}) {
    this.agentDir =
      opts.agentDir ||
      process.env.FLUX_PI_AGENT_DIR?.trim() ||
      path.join(os.homedir(), ".flux", "pi-agent");
  }

  getAgentDir(): string {
    return this.agentDir;
  }

  canExecute(backend: string): boolean {
    return normalizeExecutionBackend(backend) === "pi";
  }

  async preflight(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const modelsPath = path.join(this.agentDir, "models.json");
    try {
      await access(modelsPath, constants.R_OK);
    } catch {
      return {
        ok: false,
        reason: `missing readable PI models file at ${modelsPath}`,
      };
    }
    return { ok: true };
  }

  async execute(request: RunnerExecutionRequest): Promise<RunnerExecutionResult> {
    const renderedPrompt = request.packet.prompt?.rendered?.trim();
    if (!renderedPrompt) {
      return {
        status: "failed",
        output: "PI backend requires packet.prompt.rendered",
      };
    }

    const modelRefRaw = request.packet.execution?.model?.trim();
    if (!modelRefRaw) {
      return {
        status: "failed",
        output: "PI backend requires execution.model in packet",
      };
    }
    const parsedModel = parseModelRef(modelRefRaw);
    if (!parsedModel) {
      return {
        status: "failed",
        output: `Invalid execution.model for PI backend: ${modelRefRaw}`,
      };
    }

    const authStorage = new AuthStorage(path.join(this.agentDir, "auth.json"));
    const modelRegistry = new ModelRegistry(authStorage, path.join(this.agentDir, "models.json"));
    const model = modelRegistry.find(parsedModel.provider, parsedModel.model);
    if (!model) {
      return {
        status: "failed",
        output: `PI model not found: ${parsedModel.provider}/${parsedModel.model}`,
      };
    }
    const apiKey = await modelRegistry.getApiKey(model);
    if (!apiKey && model.api !== "bedrock-converse-stream") {
      const base = model.baseUrl.toLowerCase();
      const isLocalBase =
        base.startsWith("http://127.0.0.1") ||
        base.startsWith("http://localhost") ||
        base.startsWith("http://0.0.0.0");
      if (!isLocalBase) {
        return {
          status: "failed",
          output: `No PI auth resolved for provider/model ${parsedModel.provider}/${parsedModel.model}`,
        };
      }
    }

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir: this.agentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: "off",
      tools: [],
      customTools: [],
    });

    let streamedText = "";
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        streamedText += event.assistantMessageEvent.delta;
      }
    });
    const timeoutMs = resolveTaskTimeoutMs(request);
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      void session.abort();
    };
    request.abortSignal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== null) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        void session.abort();
      }, timeoutMs);
    }

    try {
      try {
        await session.prompt(renderedPrompt);
      } catch (error) {
        const aborted = request.abortSignal.aborted;
        if (timedOut) {
          return {
            status: "failed",
            output: `PI execution timed out after ${String(timeoutMs)}ms`,
            durationMs: Math.max(0, Date.now() - request.startedAt),
          };
        }
        return {
          status: aborted ? "cancelled" : "failed",
          output: aborted
            ? "Cancelled by user request"
            : `PI execution error: ${error instanceof Error ? error.message : String(error)}`,
          durationMs: Math.max(0, Date.now() - request.startedAt),
        };
      }

      const lastAssistant = [...session.state.messages]
        .reverse()
        .find((row) => isAssistantMessage(row)) || null;
      const fallbackText = extractAssistantText(lastAssistant);
      const outputText = streamedText.trim().length > 0 ? streamedText.trim() : fallbackText;
      let status: RunnerExecutionResult["status"] = "done";

      if (request.abortSignal.aborted || lastAssistant?.stopReason === "aborted") {
        status = "cancelled";
      } else if (lastAssistant?.stopReason === "error") {
        status = "failed";
      }

      let finalOutput =
        outputText && outputText.trim().length > 0
          ? outputText
          : status === "cancelled"
            ? "Cancelled by user request"
            : "(empty response)";

      const schemaRaw = request.packet.execution?.outputSchemaJson?.trim();
      if (status === "done" && schemaRaw) {
        const validationError = validateOutputSchema(schemaRaw, finalOutput);
        if (validationError) {
          status = "failed";
          finalOutput = `PI output validation failed: ${validationError}`;
        }
      }

      const usage = lastAssistant?.usage;
      return {
        status,
        output: finalOutput,
        tokensUsed: usage?.totalTokens,
        costUsd: usage?.cost?.total,
        durationMs: Math.max(0, Date.now() - request.startedAt),
      };
    } finally {
      request.abortSignal.removeEventListener("abort", onAbort);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      unsubscribe();
      session.dispose();
    }
  }
}
