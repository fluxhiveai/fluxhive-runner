/**
 * Shared type definitions for the FluxHive CLI and runner daemon.
 *
 * CLI types (WhoamiResponse, TaskRecord, etc.) map to the user-facing API.
 * Runner types (McpTaskPacket, McpClaimResponse, etc.) map to the MCP daemon API.
 */

export type JsonRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// CLI types (user-facing API)
// ---------------------------------------------------------------------------

/** GET /whoami */
export type WhoamiResponse = {
  agent: {
    id: string;
    slug: string;
    name: string;
  };
  server: {
    version: string;
  };
  token?: JsonRecord;
};

/** POST /agent-access/redeem */
export type RedeemResponse = {
  ok: boolean;
  credentials: {
    token: string;
    tokenType: string;
    orgId: string;
    agentId: string;
    agentSlug: string;
    agentName: string;
    issuedAt: number;
  };
};

/** POST /agent-access/request */
export type AccessRequestResponse = {
  ok: boolean;
  status: string;
  requestId: string;
  pollSecret: string;
};

/** GET /agent-access/requests/:id */
export type AccessPollResponse = {
  ok: boolean;
  status: string;
  credentials?: RedeemResponse["credentials"];
};

/** GET /tasks (CLI) */
export type TaskListResponse = {
  tasks: TaskRecord[];
  nextPollSeconds?: number;
};

export type TaskRecord = {
  id?: string;
  _id?: string;
  type?: string;
  goal?: string;
  status?: string;
  streamId?: string;
  threadId?: string;
  input?: string;
  output?: string;
  priority?: number;
  createdAt?: number;
  updatedAt?: number;
  assignedAgent?: string;
  executionBackend?: string;
  task?: {
    id?: string;
    type?: string;
    goal?: string;
    streamId?: string;
    threadId?: string;
    input?: string;
  };
};

/** POST /tasks (create) */
export type TaskCreateResponse = {
  ok: boolean;
  taskId: string;
};

/** GET /streams */
export type StreamListResponse = {
  streams: StreamRecord[];
};

export type StreamRecord = {
  id?: string;
  _id?: string;
  title?: string;
  slug?: string;
  intentMd?: string;
  status?: string;
  horizon?: string;
  parentId?: string;
};

/** GET /health */
export type HealthResponse = {
  ok: boolean;
  version?: string;
};

/** GET /openapi */
export type OpenApiResponse = JsonRecord;

// ---------------------------------------------------------------------------
// Runner / daemon types (MCP API)
// ---------------------------------------------------------------------------

/** Parsed YAML frontmatter from the org's SKILL.md manifest. */
export type SkillManifestFrontmatter = {
  protocolVersion: string;
  product?: string;
  updatedAt?: string;
  orgId: string;
  mcpHttpBase?: string;
  mcpPushWs?: string;
  joinRequestUrl?: string;
};

/** Fully resolved runner configuration (env vars + SKILL.md). */
export type RunnerConfig = {
  fluxHost: string;
  fluxToken: string;
  fluxOrgId: string;
  fluxMcpBase: string;
  skillManifestUrl: string;
  skillManifestBody: string;
  skillManifestFrontmatter: SkillManifestFrontmatter;
  runnerType: string;
  runnerVersion: string;
  runnerInstanceId: string;
  machineId: string;
  cadenceMinutes: number;
  pushReconnectMs: number;
  openclawGatewayUrl?: string;
  openclawGatewayToken?: string;
  openclawGatewayPassword?: string;
  openclawAgentId?: string;
};

/** Response from GET /whoami — identifies the agent and server (runner alias). */
export type McpWhoamiResponse = WhoamiResponse;

/** Response from POST /handshake — returns poll/push config for this runner. */
export type McpHandshakeResponse = {
  agentId: string;
  agentName: string;
  config?: {
    pollPolicy?: {
      emptyQueueSeconds?: number;
      minSeconds?: number;
      maxSeconds?: number;
    };
    maxBatchSize?: number;
    push?: {
      wsUrl?: string | null;
      mode?: "websocket" | "polling" | string;
    };
  };
};

export type McpTaskListResponse = {
  tasks: Array<McpTaskPacket>;
  nextPollSeconds?: number;
};

/**
 * A task packet from the Flux API. Fields may appear at the top level or
 * nested under `task` — the packet helpers in execution.ts handle both.
 */
export type McpTaskPacket = {
  task?: {
    id?: string;
    type?: string;
    goal?: string;
    streamId?: string;
    threadId?: string;
    input?: string;
  };
  taskId?: string;
  type?: string;
  goal?: string;
  streamId?: string;
  context?: JsonRecord;
  prompt?: {
    backend?: string;
    rendered?: string;
  };
  execution?: {
    backend?: string;
    model?: string;
    costClass?: string;
    timeoutSec?: number;
    outputSchemaJson?: string;
    allowedTools?: string[];
  };
  promptPlan?: {
    template?: string;
    vars?: JsonRecord;
  };
  policy?: {
    heartbeatRequired?: boolean;
    taskTimeoutSeconds?: number;
  };
};

export type McpClaimResponse = {
  sessionId: string;
  packet?: McpTaskPacket;
};

export type McpHeartbeatResponse = {
  shouldAbort: boolean;
  cancelPending?: boolean;
  cancelReason?: string | null;
};

export type McpCompleteStatus = "done" | "failed" | "cancelled";

/** A single text/media payload returned by an OpenClaw agent execution. */
export type OpenClawPayload = {
  text?: string;
  mediaUrl?: string;
  isError?: boolean;
};

/** Aggregated result from an OpenClaw agent execution. */
export type OpenClawResult = {
  runId?: string;
  payloads: OpenClawPayload[];
  usage?: {
    input?: number;
    output?: number;
    total?: number;
  };
  model?: string;
  provider?: string;
  durationMs?: number;
  aborted?: boolean;
};
