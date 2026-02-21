/**
 * @fluxhive/cli — Command-line interface for the FluxHive platform.
 *
 * Usage: fluxhive <command> [options]
 *
 * Global options:
 *   --json       Output as JSON
 *   --quiet      Suppress non-essential output
 *   --host       Flux API host (overrides FLUX_HOST / config file)
 *   --token      Flux API token (overrides FLUX_TOKEN / config file)
 */
import { Command } from "commander";
import { registerAuthCommands } from "./commands/auth.js";
import { registerTaskCommands } from "./commands/tasks.js";
import { registerStreamCommands } from "./commands/streams.js";
import { registerConfigCommands } from "./commands/config-cmd.js";
import { registerRunnerCommands } from "./commands/runner.js";
import { registerDaemonCommand } from "./commands/daemon.js";

const program = new Command();

program
  .name("fluxhive")
  .description("FluxHive CLI — manage agents, tasks, streams, and the runner service")
  .version("0.1.0")
  .option("--json", "Output as JSON")
  .option("--quiet", "Suppress non-essential output")
  .option("--host <url>", "Flux API host")
  .option("--token <token>", "Flux API token");

registerAuthCommands(program);
registerTaskCommands(program);
registerStreamCommands(program);
registerConfigCommands(program);
registerRunnerCommands(program);
registerDaemonCommand(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
