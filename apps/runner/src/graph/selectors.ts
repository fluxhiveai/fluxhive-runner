import type { JsonObject, RunState } from "./state.js";

export function selectStateKeys<TState extends JsonObject, K extends keyof TState>(
  state: TState,
  keys: readonly K[],
): Pick<TState, K> {
  const slice = {} as Pick<TState, K>;
  for (const key of keys) {
    slice[key] = state[key];
  }
  return slice;
}

export function selectTaskInputFromRunState(state: RunState, keys: readonly string[]): JsonObject {
  const selected: JsonObject = {};
  for (const key of keys) {
    const value = state.data[key];
    if (value !== undefined) {
      selected[key] = value;
    }
  }
  return selected;
}

export function toTaskInputJson(value: JsonObject): string {
  return JSON.stringify(value);
}
