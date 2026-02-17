import type { RunEvent } from "./run-events.js";
import type { JsonObject, JsonValue, RunState } from "./state.js";

function isPlainObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeValue(left: JsonValue | undefined, right: JsonValue): JsonValue {
  if (left === undefined) {
    return right;
  }
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return right;
  }

  const merged: JsonObject = { ...left };
  for (const [key, nextValue] of Object.entries(right)) {
    const prevValue = merged[key];
    merged[key] = deepMergeValue(prevValue, nextValue);
  }
  return merged;
}

export function mergeStateDelta(base: JsonObject, delta: JsonObject): JsonObject {
  return deepMergeValue(base, delta) as JsonObject;
}

export function reduceRunState(state: RunState, event: RunEvent): RunState {
  const nextUpdatedAt = event.createdAt;
  switch (event.type) {
    case "run_started":
      return {
        ...state,
        status: "running",
        data: mergeStateDelta(state.data, event.payload.initialState),
        stateVersion: state.stateVersion + 1,
        updatedAt: nextUpdatedAt,
      };
    case "step_started":
      return {
        ...state,
        currentStep: event.payload.step,
        updatedAt: nextUpdatedAt,
      };
    case "state_delta_applied":
      return {
        ...state,
        currentStep: event.payload.step ?? state.currentStep,
        data: mergeStateDelta(state.data, event.payload.delta),
        stateVersion: state.stateVersion + 1,
        updatedAt: nextUpdatedAt,
      };
    case "step_completed":
      return {
        ...state,
        currentStep: event.payload.step,
        updatedAt: nextUpdatedAt,
      };
    case "step_failed":
      return {
        ...state,
        status: "failed",
        currentStep: event.payload.step,
        error: event.payload.error,
        updatedAt: nextUpdatedAt,
      };
    case "run_paused":
      return {
        ...state,
        status: "paused",
        updatedAt: nextUpdatedAt,
      };
    case "run_resumed":
      return {
        ...state,
        status: "running",
        updatedAt: nextUpdatedAt,
      };
    case "run_completed":
      return {
        ...state,
        status: "completed",
        completedAt: nextUpdatedAt,
        updatedAt: nextUpdatedAt,
      };
    case "run_failed":
      return {
        ...state,
        status: "failed",
        error: event.payload.error,
        updatedAt: nextUpdatedAt,
      };
    default:
      return state;
  }
}

export function reduceRunEvents(initial: RunState, events: RunEvent[]): RunState {
  return events
    .toSorted((a, b) => a.seq - b.seq)
    .reduce((acc, event) => reduceRunState(acc, event), initial);
}
