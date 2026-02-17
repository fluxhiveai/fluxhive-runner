import { describe, expect, it } from "vitest";
import type { TaskStatus } from "./types.js";
import { VALID_TRANSITIONS } from "./types.js";

describe("VALID_TRANSITIONS", () => {
  const allStatuses: TaskStatus[] = [
    "todo",
    "doing",
    "blocked",
    "review",
    "done",
    "failed",
    "cancelled",
  ];

  it("has an entry for every TaskStatus", () => {
    const keys = Object.keys(VALID_TRANSITIONS);
    for (const status of allStatuses) {
      expect(keys).toContain(status);
    }
    expect(keys).toHaveLength(allStatuses.length);
  });

  it("marks 'done' as a terminal state with no outgoing transitions", () => {
    expect(VALID_TRANSITIONS.done).toEqual([]);
  });

  it("allows 'failed' to retry only to 'todo'", () => {
    expect(VALID_TRANSITIONS.failed).toEqual(["todo", "cancelled"]);
  });

  it("allows 'todo' to transition to doing, blocked, failed", () => {
    expect(VALID_TRANSITIONS.todo).toContain("doing");
    expect(VALID_TRANSITIONS.todo).toContain("blocked");
    expect(VALID_TRANSITIONS.todo).toContain("failed");
    expect(VALID_TRANSITIONS.todo).toContain("cancelled");
    expect(VALID_TRANSITIONS.todo).toHaveLength(4);
  });

  it("allows 'doing' to transition to review, done, blocked, failed", () => {
    expect(VALID_TRANSITIONS.doing).toContain("review");
    expect(VALID_TRANSITIONS.doing).toContain("done");
    expect(VALID_TRANSITIONS.doing).toContain("blocked");
    expect(VALID_TRANSITIONS.doing).toContain("failed");
    expect(VALID_TRANSITIONS.doing).toContain("cancelled");
    expect(VALID_TRANSITIONS.doing).toHaveLength(5);
  });

  it("does not allow any status to transition to itself", () => {
    for (const status of allStatuses) {
      expect(VALID_TRANSITIONS[status]).not.toContain(status);
    }
  });
});
