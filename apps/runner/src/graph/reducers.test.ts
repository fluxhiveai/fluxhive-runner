import { describe, expect, it } from "vitest";
import type { RunEvent, RunEventByType } from "./run-events.js";
import type { RunState } from "./state.js";
import { reduceRunEvents, reduceRunState } from "./reducers.js";

function baseState(): RunState {
  return {
    runId: "pipe-1",
    squadId: "squad-1",
    playbookName: "content",
    status: "pending",
    stateVersion: 0,
    data: {},
    startedAt: 1000,
    updatedAt: 1000,
  };
}

describe("graph reducers", () => {
  it("merges nested state delta immutably", () => {
    const initial = baseState();
    const event: RunEventByType<"state_delta_applied"> = {
      runId: "pipe-1",
      seq: 1,
      createdAt: 1010,
      type: "state_delta_applied",
      payload: {
        delta: {
          research: {
            keywords: ["a", "b"],
            score: 1,
          },
        },
      },
    };

    const next = reduceRunState(initial, event);
    expect(next).not.toBe(initial);
    expect(next.data).toEqual({
      research: {
        keywords: ["a", "b"],
        score: 1,
      },
    });
    expect(next.stateVersion).toBe(1);
  });

  it("replays events deterministically by seq", () => {
    const initial = baseState();
    const events: RunEvent[] = [
      {
        runId: "pipe-1",
        seq: 3,
        createdAt: 1030,
        type: "state_delta_applied",
        payload: { step: "draft", delta: { draft: "hello" } },
      },
      {
        runId: "pipe-1",
        seq: 1,
        createdAt: 1010,
        type: "run_started",
        payload: { initialState: { topic: "cats" } },
      },
      {
        runId: "pipe-1",
        seq: 2,
        createdAt: 1020,
        type: "step_started",
        payload: { step: "draft" },
      },
      {
        runId: "pipe-1",
        seq: 4,
        createdAt: 1040,
        type: "run_completed",
        payload: {},
      },
    ];

    const reduced = reduceRunEvents(initial, events);
    expect(reduced.status).toBe("completed");
    expect(reduced.currentStep).toBe("draft");
    expect(reduced.data).toEqual({ topic: "cats", draft: "hello" });
    expect(reduced.completedAt).toBe(1040);
  });
});
