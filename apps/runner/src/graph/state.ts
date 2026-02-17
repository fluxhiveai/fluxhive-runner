import { z } from "zod";

export const runStatusSchema = z.enum(["pending", "running", "paused", "completed", "failed"]);

export type RunStatus = z.infer<typeof runStatusSchema>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

export const runStateSchema = z.object({
  runId: z.string(),
  squadId: z.string(),
  playbookName: z.string(),
  status: runStatusSchema,
  currentStep: z.string().optional(),
  stateVersion: z.number().int().nonnegative(),
  data: jsonObjectSchema,
  startedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

export type RunState = z.infer<typeof runStateSchema>;
