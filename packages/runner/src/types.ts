export type JsonRecord = Record<string, unknown>;

export type SkillManifestFrontmatter = {
  protocolVersion: string;
  product?: string;
  updatedAt?: string;
  orgId: string;
  mcpHttpBase?: string;
  mcpPushWs?: string;
  joinRequestUrl?: string;
};

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

export type McpWhoamiResponse = {
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

export type OpenClawPayload = {
  text?: string;
  mediaUrl?: string;
  isError?: boolean;
};

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
