import type { ConvexClient } from "convex/browser";

export type IntegrationRow = {
  _id: string;
  streamId?: string;
  type: string;
  name: string;
  config?: unknown;
  settings?: unknown;
  intakeConfig?: unknown;
  pollIntervalSeconds?: number;
  intakeCursor?: string;
  watcherCursor?: string;
  secretRef?: string;
  enabled: boolean;
};

export type IntegrationIntakeAdapter = {
  type: string;
  pollIntegration: (args: { integration: IntegrationRow; client: ConvexClient }) => Promise<void>;
  stop?: () => Promise<void> | void;
};
