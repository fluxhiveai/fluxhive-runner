/**
 * Stream commands: list.
 */
import type { Command } from "commander";
import { FluxApiClient } from "../client.js";
import { resolveConfig } from "../config.js";
import * as out from "../output.js";

export function registerStreamCommands(program: Command): void {
  const streams = program
    .command("streams")
    .description("Manage streams");

  streams
    .command("list")
    .description("List streams")
    .option("-s, --status <status>", "Filter by status (active, paused, archived, all)")
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      try {
        const config = resolveConfig(globalOpts);
        const client = new FluxApiClient({
          baseUrl: config.mcpBase,
          token: config.token,
        });

        const res = await client.listStreams({
          status: opts.status,
        });

        if (globalOpts.json) {
          out.json(res);
        } else {
          if (res.streams.length === 0) {
            console.log(out.dim("No streams found."));
            return;
          }

          out.table(
            ["ID", "Title", "Slug", "Status", "Horizon"],
            res.streams.map((s) => [
              s._id ?? s.id ?? "",
              out.truncate(s.title ?? "", 40),
              s.slug ?? "",
              s.status ?? "",
              s.horizon ?? "",
            ]),
          );
          console.log(
            out.dim(`\n  ${res.streams.length} stream(s) shown`),
          );
        }
      } catch (err) {
        handleError(err);
      }
    });
}

function handleError(err: unknown): never {
  if (err instanceof Error) {
    out.error(err.message);
  }
  out.error(String(err));
}
