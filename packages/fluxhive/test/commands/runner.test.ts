import { describe, expect, it, vi, beforeEach } from "vitest";
import { Command } from "commander";

const mockHandleServiceCommand = vi.fn();

vi.mock("../../src/runner/service.js", () => ({
  handleServiceCommand: (...args: unknown[]) => mockHandleServiceCommand(...args),
}));

const mockError = vi.fn();
vi.mock("../../src/output.js", () => ({
  error: (...args: unknown[]) => mockError(...args),
}));

const { registerRunnerCommands } = await import("../../src/commands/runner.ts");

function makeProgram() {
  const program = new Command();
  registerRunnerCommands(program);
  program.exitOverride();
  return program;
}

describe("runner commands", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const action of ["install", "status", "stop", "restart", "uninstall"] as const) {
    it(`calls handleServiceCommand("${action}")`, async () => {
      mockHandleServiceCommand.mockImplementation(() => {
        throw Object.assign(new Error(`process.exit(0)`), { code: 0 });
      });
      try {
        await makeProgram().parseAsync(["node", "fluxhive", "runner", action]);
      } catch {
        // expected — handleServiceCommand calls process.exit
      }
      expect(mockHandleServiceCommand).toHaveBeenCalledWith(action);
    });
  }

  it("surfaces unexpected errors via out.error", async () => {
    mockHandleServiceCommand.mockImplementation(() => {
      throw new Error("something broke");
    });
    await makeProgram().parseAsync(["node", "fluxhive", "runner", "install"]);
    expect(mockError).toHaveBeenCalledWith("something broke");
  });
});
