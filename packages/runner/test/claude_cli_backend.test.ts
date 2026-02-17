import { describe, expect, it } from "vitest";
import { parseClaudeCliOutput } from "../src/claude_cli_backend.js";

describe("parseClaudeCliOutput", () => {
  it("returns raw JSON if not nested", () => {
    const raw = JSON.stringify({ ok: true, result: { a: 1 } });
    expect(parseClaudeCliOutput(raw)).toBe(raw);
  });

  it("unwraps nested result string when it is JSON", () => {
    const inner = JSON.stringify({ message: "pong" });
    const raw = JSON.stringify({ result: inner });
    expect(parseClaudeCliOutput(raw)).toBe(inner);
  });

  it("returns trimmed raw when not JSON", () => {
    expect(parseClaudeCliOutput("  hello  ")).toBe("hello");
  });
});

