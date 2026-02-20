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

// pi-agent-core reads package.json from the bundle's directory at module load
// time. When running standalone from ~/.flux/ (no repo), we must create a stub
// BEFORE any imports that transitively pull in pi-agent-core.
import { existsSync as _exists, writeFileSync as _write, mkdirSync as _mkdir } from "node:fs";
import { dirname as _dirname, join as _join } from "node:path";
import { fileURLToPath as _toPath } from "node:url";
const _bundleDir = _dirname(_toPath(import.meta.url));
const _stubPkg = _join(_bundleDir, "package.json");
if (!_exists(_stubPkg)) {
  try {
    _mkdir(_bundleDir, { recursive: true });
    _write(_stubPkg, '{"name":"fluxhive-runner","version":"0.0.0","type":"module"}\n');
  } catch {
    // Best-effort — if we can't write (e.g. read-only fs), pi will fail with its own error
  }
}

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
