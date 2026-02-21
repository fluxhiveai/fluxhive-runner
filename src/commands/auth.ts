/**
 * Auth commands: whoami, access redeem/request/poll.
 */
import type { Command } from "commander";
import { FluxApiClient } from "../client.js";
import { resolveConfig, writeConfigFile, getConfigFilePath } from "../config.js";
import * as out from "../output.js";

export function registerAuthCommands(program: Command): void {
  // fluxhive whoami — top-level shortcut
  program
    .command("whoami")
    .description("Show current agent identity and token info")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      try {
        const config = resolveConfig(globalOpts);
        const client = new FluxApiClient({
          baseUrl: config.mcpBase,
          token: config.token,
        });
        const res = await client.whoami();

        if (globalOpts.json) {
          out.json(res);
        } else {
          console.log(out.bold("Agent Identity"));
          out.keyValue([
            ["Name", res.agent.name],
            ["Slug", res.agent.slug],
            ["ID", res.agent.id],
            ["Server", res.server.version],
          ]);
        }
      } catch (err) {
        handleError(err);
      }
    });

  // fluxhive access <subcommand>
  const access = program
    .command("access")
    .description("Manage agent access and invites");

  access
    .command("redeem")
    .description("Redeem an invite code and save credentials to ~/.flux/config.json")
    .requiredOption("--invite <code>", "Invite code")
    .requiredOption("--org <orgId>", "Organization ID")
    .option("--label <label>", "Agent label")
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const host = globalOpts.host || process.env.FLUX_HOST;
      if (!host) {
        out.error(
          "No host configured. Use --host or set FLUX_HOST.",
        );
      }
      const normalizedHost = host.replace(/\/+$/, "");
      const mcpBase = `${normalizedHost}/mcp/v1`;

      try {
        const client = new FluxApiClient({ baseUrl: mcpBase });
        const res = await client.accessRedeem({
          orgId: opts.org,
          inviteCode: opts.invite,
          agentLabel: opts.label,
        });

        writeConfigFile({
          host: normalizedHost,
          token: res.credentials.token,
          orgId: res.credentials.orgId,
        });

        if (globalOpts.json) {
          out.json(res);
        } else {
          console.log(out.green("Invite redeemed successfully!"));
          console.log();
          out.keyValue([
            ["Agent", res.credentials.agentName],
            ["Slug", res.credentials.agentSlug],
            ["Org ID", res.credentials.orgId],
            ["Config", getConfigFilePath()],
          ]);
          console.log();
          console.log(
            out.dim("Token saved. You can now run 'fluxhive whoami' to verify."),
          );
        }
      } catch (err) {
        handleError(err);
      }
    });

  access
    .command("request")
    .description("Request org access (creates a pending request)")
    .requiredOption("--invite <code>", "Invite code")
    .requiredOption("--org <orgId>", "Organization ID")
    .option("--label <label>", "Agent label")
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const host = globalOpts.host || process.env.FLUX_HOST;
      if (!host) {
        out.error("No host configured. Use --host or set FLUX_HOST.");
      }
      const normalizedHost = host.replace(/\/+$/, "");
      const mcpBase = `${normalizedHost}/mcp/v1`;

      try {
        const client = new FluxApiClient({ baseUrl: mcpBase });
        const res = await client.accessRequest({
          orgId: opts.org,
          inviteCode: opts.invite,
          agentLabel: opts.label,
        });

        if (globalOpts.json) {
          out.json(res);
        } else {
          console.log(out.green("Access request submitted!"));
          console.log();
          out.keyValue([
            ["Request ID", res.requestId],
            ["Status", res.status],
            ["Poll Secret", res.pollSecret],
          ]);
          console.log();
          console.log(
            out.dim(
              `Poll with: fluxhive access poll --id ${res.requestId} --secret ${res.pollSecret}`,
            ),
          );
        }
      } catch (err) {
        handleError(err);
      }
    });

  access
    .command("poll")
    .description("Poll the status of an access request")
    .requiredOption("--id <requestId>", "Request ID")
    .requiredOption("--secret <pollSecret>", "Poll secret")
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const host = globalOpts.host || process.env.FLUX_HOST;
      if (!host) {
        out.error("No host configured. Use --host or set FLUX_HOST.");
      }
      const normalizedHost = host.replace(/\/+$/, "");
      const mcpBase = `${normalizedHost}/mcp/v1`;

      try {
        const client = new FluxApiClient({ baseUrl: mcpBase });
        const res = await client.accessPoll(opts.id, opts.secret);

        if (globalOpts.json) {
          out.json(res);
        } else {
          out.keyValue([
            ["Status", res.status],
          ]);
          if (res.credentials) {
            console.log();
            console.log(out.green("Access granted! Saving credentials..."));
            writeConfigFile({
              host: normalizedHost,
              token: res.credentials.token,
              orgId: res.credentials.orgId,
            });
            out.keyValue([
              ["Agent", res.credentials.agentName],
              ["Config", getConfigFilePath()],
            ]);
          }
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
