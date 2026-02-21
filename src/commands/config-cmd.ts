/**
 * Config/utility commands: health, config, openapi.
 */
import type { Command } from "commander";
import { FluxApiClient } from "../client.js";
import { resolveConfig, getConfigFilePath, getConfigDir } from "../config.js";
import * as out from "../output.js";

export function registerConfigCommands(program: Command): void {
  // fluxhive health — top-level shortcut
  program
    .command("health")
    .description("Check API connectivity")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      try {
        const config = resolveConfig(globalOpts);
        const client = new FluxApiClient({
          baseUrl: config.mcpBase,
          token: config.token,
        });
        const res = await client.health();

        if (globalOpts.json) {
          out.json(res);
        } else {
          if (res.ok) {
            console.log(out.green("API is healthy"));
          } else {
            console.log(out.red("API returned unhealthy status"));
          }
          if (res.version) {
            out.keyValue([["Version", res.version]]);
          }
        }
      } catch (err) {
        handleError(err);
      }
    });

  // fluxhive config — top-level shortcut
  program
    .command("config")
    .description("Show resolved configuration")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      try {
        const config = resolveConfig(globalOpts);

        if (globalOpts.json) {
          out.json({
            host: config.host,
            mcpBase: config.mcpBase,
            orgId: config.orgId ?? null,
            tokenSet: !!config.token,
            configFile: getConfigFilePath(),
            configDir: getConfigDir(),
          });
        } else {
          console.log(out.bold("Resolved Configuration"));
          out.keyValue([
            ["Host", config.host],
            ["MCP Base", config.mcpBase],
            ["Org ID", config.orgId],
            ["Token", config.token ? maskToken(config.token) : undefined],
            ["Config File", getConfigFilePath()],
            ["Config Dir", getConfigDir()],
          ]);
        }
      } catch (err) {
        handleError(err);
      }
    });

  // fluxhive openapi — top-level shortcut
  program
    .command("openapi")
    .description("Dump the OpenAPI spec")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      try {
        const config = resolveConfig(globalOpts);
        const client = new FluxApiClient({
          baseUrl: config.mcpBase,
          token: config.token,
        });
        const res = await client.openapi();

        // Always output as JSON regardless of --json flag
        out.json(res);
      } catch (err) {
        handleError(err);
      }
    });
}

function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return token.slice(0, 4) + "…" + token.slice(-4);
}

function handleError(err: unknown): never {
  if (err instanceof Error) {
    out.error(err.message);
  }
  out.error(String(err));
}
