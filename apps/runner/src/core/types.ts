// Agent statuses
export type AgentStatus = "active" | "inactive" | "archived";

// Task statuses matching the Convex schema
export type TaskStatus = "todo" | "doing" | "blocked" | "review" | "done" | "failed" | "cancelled";

// Work flavors
export type WorkKind = "impulse" | "arc" | "flow";

// Valid status transitions
export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["doing", "blocked", "failed", "cancelled"],
  doing: ["review", "done", "blocked", "failed", "cancelled"],
  blocked: ["todo", "doing", "failed", "cancelled"],
  review: ["done", "doing", "failed", "cancelled"],
  done: [],
  failed: ["todo", "cancelled"],
  cancelled: [],
};

// Event types matching the Convex schema
export type EventType =
  | "result"
  | "question"
  | "handover"
  | "error"
  | "log"
  | "blocked"
  | "gate_pending"
  | "gate_approved"
  | "gate_rejected"
  | "timeout"
  | "notification"
  | "consumer_grade";

// Session statuses
export type SessionStatus = "running" | "idle" | "failed";

// Task as returned from Convex
export type Task = {
  _id: string;
  _creationTime: number;
  parentId?: string;
  streamId?: string;
  runId?: string;
  goalId?: string;
  goal: string;
  type: string;
  workKind?: WorkKind;
  status: TaskStatus;
  input: string;
  output?: string;
  source?: string;
  externalId?: string;
  externalStatus?: string;
  externalSyncedAt?: number;
  workflow?: string;
  agentId?: string;
  skillId?: string;
  dependencies?: string[];
  contextFrom?: string[];
  retryCount?: number;
  expectedDurationSec?: number;
  startedAt?: number;
  updatedAt: number;
};

// Event as returned from Convex
export type Event = {
  _id: string;
  _creationTime: number;
  taskId: string;
  type: EventType;
  content: string;
  fromAgent: string;
  timestamp: number;
};

// Agent session as returned from Convex
export type AgentSession = {
  _id: string;
  _creationTime: number;
  taskId: string;
  sessionId: string;
  status: SessionStatus;
  phase?: string;
  lastHeartbeat?: number;
  model?: string;
  tokensUsed?: number;
  costUsd?: number;
  killedAt?: number;
  killReason?: string;
  endedAt?: number;
};

// Agent as returned from Convex
export type Agent = {
  _id: string;
  _creationTime: number;
  name: string;
  slug: string;
  role?: string;
  soul?: string;
  identity?: string;
  procedures?: string;
  creature?: string;
  vibe?: string;
  emoji?: string;
  avatar?: string;
  model?: string;
  openclawAgentId?: string;
  skills?: string[];
  status: AgentStatus;
  updatedAt: number;
};

// Input for creating a new task
export type NewTask = {
  parentId?: string;
  streamId?: string;
  goal: string;
  type: string;
  input: string;
  source?: string;
  externalId?: string;
  workflow?: string;
  agentId?: string;
  skillId?: string;
  dependencies?: string[];
  contextFrom?: string[];
  expectedDurationSec?: number;
  goalId?: string;
};

// Repo context for prompt template variable substitution.
export type RepoContext = {
  owner?: string;
  repo?: string;
  repoPath?: string;
  projectNumber?: number;
  fields?: Record<string, FieldConfig>;
};

// Integration config (replaces SquadConfig for GitHub adapter)
export type IntegrationConfig = {
  owner: string;
  repo: string;
  repoPath?: string;
  projectId?: string;
  projectNumber?: number;
  pollIntervalSeconds: number;
  stages?: Record<string, StageConfig>;
  fields?: Record<string, FieldConfig>;
};

export type StageConfig = {
  agent: string | null;
};

export type FieldConfig = {
  fieldId: string;
  options: Record<string, string>;
};

// Cadence types (used by cadence-scheduler)
export type CadenceUnit = "minutes" | "hours" | "days" | "weeks" | "months";
export type Cadence = {
  every: number;
  unit: CadenceUnit;
};

// Context passed to task sources and the supervisor
export type RuntimeContext = {
  convexUrl: string;
};

// Interface for task sources (GitHub, manual, etc.)
export type TaskSource = {
  id: string;
  start: (ctx: RuntimeContext) => Promise<void>;
  stop: () => Promise<void>;
};
