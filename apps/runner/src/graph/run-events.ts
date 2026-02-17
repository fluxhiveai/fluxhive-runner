import { z } from "zod";
import { jsonObjectSchema } from "./state.js";

export const runEventTypeSchema = z.enum([
  "run_started",
  "step_started",
  "state_delta_applied",
  "step_completed",
  "step_failed",
  "run_paused",
  "run_resumed",
  "run_completed",
  "run_failed",
]);

export type RunEventType = z.infer<typeof runEventTypeSchema>;

const runStartedPayloadSchema = z.object({
  initialState: jsonObjectSchema.default({}),
});

const stepStartedPayloadSchema = z.object({
  step: z.string(),
});

const stateDeltaAppliedPayloadSchema = z.object({
  step: z.string().optional(),
  delta: jsonObjectSchema,
});

const stepCompletedPayloadSchema = z.object({
  step: z.string(),
  summary: z.string().optional(),
});

const stepFailedPayloadSchema = z.object({
  step: z.string(),
  error: z.string(),
});

const runPausedPayloadSchema = z.object({
  reason: z.string().optional(),
});

const runResumedPayloadSchema = z.object({
  reason: z.string().optional(),
});

const runCompletedPayloadSchema = z.object({
  summary: z.string().optional(),
});

const runFailedPayloadSchema = z.object({
  error: z.string(),
});

export const runEventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run_started"), payload: runStartedPayloadSchema }),
  z.object({ type: z.literal("step_started"), payload: stepStartedPayloadSchema }),
  z.object({ type: z.literal("state_delta_applied"), payload: stateDeltaAppliedPayloadSchema }),
  z.object({ type: z.literal("step_completed"), payload: stepCompletedPayloadSchema }),
  z.object({ type: z.literal("step_failed"), payload: stepFailedPayloadSchema }),
  z.object({ type: z.literal("run_paused"), payload: runPausedPayloadSchema }),
  z.object({ type: z.literal("run_resumed"), payload: runResumedPayloadSchema }),
  z.object({ type: z.literal("run_completed"), payload: runCompletedPayloadSchema }),
  z.object({ type: z.literal("run_failed"), payload: runFailedPayloadSchema }),
]);

export const runEventSchema = z.object({
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  type: runEventTypeSchema,
  payload: jsonObjectSchema,
});

type RunEventPayloadByType = {
  run_started: z.infer<typeof runStartedPayloadSchema>;
  step_started: z.infer<typeof stepStartedPayloadSchema>;
  state_delta_applied: z.infer<typeof stateDeltaAppliedPayloadSchema>;
  step_completed: z.infer<typeof stepCompletedPayloadSchema>;
  step_failed: z.infer<typeof stepFailedPayloadSchema>;
  run_paused: z.infer<typeof runPausedPayloadSchema>;
  run_resumed: z.infer<typeof runResumedPayloadSchema>;
  run_completed: z.infer<typeof runCompletedPayloadSchema>;
  run_failed: z.infer<typeof runFailedPayloadSchema>;
};

export type RunEventByType<TType extends RunEventType> = {
  runId: string;
  seq: number;
  createdAt: number;
  type: TType;
  payload: RunEventPayloadByType[TType];
};

export type RunEvent = {
  [K in RunEventType]: RunEventByType<K>;
}[RunEventType];

export function validateRunEvent<TType extends RunEventType>(
  event: RunEventByType<TType>,
): RunEventByType<TType> {
  // Validate envelope first.
  runEventSchema.parse({
    runId: event.runId,
    seq: event.seq,
    createdAt: event.createdAt,
    type: event.type,
    payload: event.payload,
  });
  // Then validate type-specific payload.
  runEventPayloadSchema.parse({ type: event.type, payload: event.payload });
  return event;
}
