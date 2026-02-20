/**
 * Task commands: list, create.
 */
import type { Command } from "commander";
import { FluxApiClient } from "../client.js";
import { resolveConfig } from "../config.js";
import * as out from "../output.js";

export function registerTaskCommands(program: Command): void {
  const tasks = program
    .command("tasks")
    .description("Manage tasks");

  tasks
    .command("list")
    .description("List tasks")
    .option("-s, --status <status>", "Filter by status (todo, doing, done, etc.)")
    .option("-l, --limit <n>", "Max results", "20")
    .option("--stream-id <id>", "Filter by stream ID")
    .option("--backend <backend>", "Filter by execution backend")
    .option("--cost-class <class>", "Filter by cost class")
    .option("--mode <mode>", "Response mode (full, compact)")
    .option("--format <format>", "Response format (enriched, packet)")
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      try {
        const config = resolveConfig(globalOpts);
        const client = new FluxApiClient({
          baseUrl: config.mcpBase,
          token: config.token,
        });

        const res = await client.listTasks({
          status: opts.status,
          limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
          streamId: opts.streamId,
          backend: opts.backend,
          costClass: opts.costClass,
          mode: opts.mode,
          format: opts.format,
        });

        if (globalOpts.json) {
          out.json(res);
        } else {
          if (res.tasks.length === 0) {
            console.log(out.dim("No tasks found."));
            return;
          }

          out.table(
            ["ID", "Status", "Type", "Goal", "Stream"],
            res.tasks.map((t) => {
              const id = t._id ?? t.id ?? t.task?.id ?? "";
              const status = t.status ?? "";
              const type = t.type ?? t.task?.type ?? "";
              const goal = out.truncate(t.goal ?? t.task?.goal ?? "", 50);
              const stream = t.streamId ?? t.task?.streamId ?? "";
              return [id, status, type, goal, stream];
            }),
          );
          console.log(
            out.dim(`\n  ${res.tasks.length} task(s) shown`),
          );
        }
      } catch (err) {
        handleError(err);
      }
    });

  tasks
    .command("create")
    .description("Create a new task")
    .requiredOption("--goal <goal>", "Task goal")
    .requiredOption("--input <input>", "Task input")
    .option("--type <type>", "Task type", "general")
    .option("--stream-id <id>", "Stream ID")
    .option("--skill-id <id>", "Skill ID")
    .option("--priority <n>", "Priority (lower = higher priority)")
    .option("--backend <backend>", "Execution backend")
    .option("--model <model>", "Execution model")
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      try {
        const config = resolveConfig(globalOpts);
        const client = new FluxApiClient({
          baseUrl: config.mcpBase,
          token: config.token,
        });

        const res = await client.createTask({
          type: opts.type,
          goal: opts.goal,
          input: opts.input,
          streamId: opts.streamId,
          skillId: opts.skillId,
          priority: opts.priority ? parseInt(opts.priority, 10) : undefined,
          executionBackend: opts.backend,
          executionModel: opts.model,
        });

        if (globalOpts.json) {
          out.json(res);
        } else {
          console.log(out.green("Task created!"));
          out.keyValue([["Task ID", res.taskId]]);
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
