import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Force NO_COLOR so output is predictable in tests
// ---------------------------------------------------------------------------

process.env.NO_COLOR = "1";
const { bold, dim, green, red, yellow, cyan, truncate, error, json, keyValue, table } =
  await import("../src/output.ts");

describe("color functions with NO_COLOR", () => {
  it("bold returns plain text", () => {
    expect(bold("hello")).toBe("hello");
  });

  it("dim returns plain text", () => {
    expect(dim("faded")).toBe("faded");
  });

  it("green returns plain text", () => {
    expect(green("ok")).toBe("ok");
  });

  it("red returns plain text", () => {
    expect(red("error")).toBe("error");
  });

  it("yellow returns plain text", () => {
    expect(yellow("warn")).toBe("warn");
  });

  it("cyan returns plain text", () => {
    expect(cyan("info")).toBe("info");
  });
});

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns strings at exact limit unchanged", () => {
    expect(truncate("12345", 5)).toBe("12345");
  });

  it("truncates long strings with ellipsis", () => {
    const result = truncate("hello world this is long", 10);
    expect(result).toHaveLength(10);
    expect(result.endsWith("\u2026")).toBe(true);
  });

  it("handles empty strings", () => {
    expect(truncate("", 5)).toBe("");
  });
});

describe("error", () => {
  const origExit = process.exit;
  const origConsoleError = console.error;

  beforeEach(() => {
    console.error = vi.fn();
    process.exit = vi.fn() as never;
  });
  afterEach(() => {
    process.exit = origExit;
    console.error = origConsoleError;
  });

  it("prints red error and calls process.exit(1)", () => {
    error("something broke");
    expect(console.error).toHaveBeenCalledWith("Error: something broke");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe("json", () => {
  it("prints formatted JSON", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    json({ key: "value", num: 42 });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ key: "value", num: 42 }, null, 2));
    log.mockRestore();
  });
});

describe("keyValue", () => {
  it("prints key-value pairs", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    keyValue([
      ["Name", "Agent"],
      ["ID", "123"],
    ]);
    expect(log).toHaveBeenCalledTimes(2);
    const firstCall = log.mock.calls[0][0] as string;
    expect(firstCall).toContain("Name");
    expect(firstCall).toContain("Agent");
    log.mockRestore();
  });

  it("shows (none) for undefined values", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    keyValue([["Key", undefined]]);
    const call = log.mock.calls[0][0] as string;
    expect(call).toContain("(none)");
    log.mockRestore();
  });
});

describe("table", () => {
  it("prints (no results) for empty rows", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    table(["A", "B"], []);
    expect(log).toHaveBeenCalledTimes(1);
    const call = log.mock.calls[0][0] as string;
    expect(call).toContain("no results");
    log.mockRestore();
  });

  it("prints header, separator, and data rows", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    table(
      ["Name", "Status"],
      [
        ["Alice", "active"],
        ["Bob", "paused"],
      ],
    );
    // header + separator + 2 rows = 4 calls
    expect(log).toHaveBeenCalledTimes(4);
    const headerCall = log.mock.calls[0][0] as string;
    expect(headerCall).toContain("Name");
    expect(headerCall).toContain("Status");
    log.mockRestore();
  });

  it("handles rows with missing cells", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    table(["A", "B", "C"], [["only-one"]]);
    expect(log).toHaveBeenCalledTimes(3); // header + sep + 1 row
    log.mockRestore();
  });
});
