import type { ConvexClient } from "convex/browser";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { api } from "./convex-client.js";

const log = createSubsystemLogger("flux").child("llm-log");

export type LlmLogWriteArgs = {
  source: string;
  provider?: string;
  model?: string;
  operatorAgentId?: string;
  operatorAgentName?: string;
  openclawAgentId?: string;
  taskId?: string;
  runId?: string;
  requestText?: string;
  responseText?: string;
  requestJson?: string;
  responseJson?: string;
  usageJson?: string;
  durationMs?: number;
  isError: boolean;
  errorText?: string;
};

export async function safeWriteLlmLog(client: ConvexClient, args: LlmLogWriteArgs): Promise<void> {
  try {
    // Strip fields not declared in the llmLogs.create mutation args
    const { openclawAgentId: _, ...rest } = args;
    await client.mutation(api.llmLogs.create, rest);
  } catch (error: unknown) {
    log.warn(`failed to persist llm log: ${String(error)}`);
  }
}
