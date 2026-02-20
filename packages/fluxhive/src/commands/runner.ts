/**
 * Runner service management commands: install, status, stop, restart, uninstall.
 *
 * Real implementation wrapping handleServiceCommand from runner/service.ts.
 */
import type { Command } from "commander";
import { handleServiceCommand } from "../runner/service.js";
import * as out from "../output.js";

export function registerRunnerCommands(program: Command): void {
  const runner = program
    .command("runner")
    .description("Manage the FluxHive runner daemon service");

  runner
    .command("install")
    .description("Install the runner as a persistent system service")
    .action(async () => {
      try {
        handleServiceCommand("install");
      } catch (err) {
        // handleServiceCommand calls process.exit — if it throws, surface the error
        if (err instanceof Error && err.message.startsWith("process.exit(")) return;
        out.error(err instanceof Error ? err.message : String(err));
      }
    });

  runner
    .command("status")
    .description("Show the runner service status")
    .action(async () => {
      try {
        handleServiceCommand("status");
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("process.exit(")) return;
        out.error(err instanceof Error ? err.message : String(err));
      }
    });

  runner
    .command("stop")
    .description("Stop the runner service")
    .action(async () => {
      try {
        handleServiceCommand("stop");
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("process.exit(")) return;
        out.error(err instanceof Error ? err.message : String(err));
      }
    });

  runner
    .command("restart")
    .description("Restart the runner service")
    .action(async () => {
      try {
        handleServiceCommand("restart");
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("process.exit(")) return;
        out.error(err instanceof Error ? err.message : String(err));
      }
    });

  runner
    .command("uninstall")
    .description("Uninstall the runner service")
    .option("--clean", "Also remove ~/.flux/ directory (config, tokens, logs)")
    .action(async () => {
      try {
        handleServiceCommand("uninstall");
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("process.exit(")) return;
        out.error(err instanceof Error ? err.message : String(err));
      }
    });
}
