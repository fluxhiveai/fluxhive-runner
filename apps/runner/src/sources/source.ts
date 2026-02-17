import type { RuntimeContext } from "../core/types.js";

// TaskSource interface for intake/feedback/background workers.
export type TaskSource = {
  id: string;
  start: (ctx: RuntimeContext) => Promise<void>;
  stop: () => Promise<void>;
};
