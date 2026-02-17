# TOOLS — {LEADER_NAME}

Tools available to me as leader of the {SQUAD_NAME} squad.

---

## Squad Query CLI

Command: `pnpm openclaw squads query <command> [options]`

My squad slug is `{SQUAD_SLUG}`. My squad ID is `{SQUAD_ID}`.

### Read Commands

#### status — Squad overview

```bash
pnpm openclaw squads query status --squad {SQUAD_SLUG}
```

Returns: task counts, rock counts, vision summary.

#### rocks — Current rocks

```bash
pnpm openclaw squads query rocks --squad {SQUAD_SLUG}
```

Returns: all rocks for the current cycle with status.

#### tasks — Active tasks

```bash
pnpm openclaw squads query tasks --squad {SQUAD_SLUG}
```

Returns: all non-done tasks with assignee and status.

#### kpis — Scorecard metrics

```bash
pnpm openclaw squads query kpis --squad {SQUAD_SLUG}
```

Returns: all KPIs with current values, targets, and direction.

#### vision — Squad vision

```bash
pnpm openclaw squads query vision --squad {SQUAD_SLUG}
```

Returns: the current vision statement.

#### reviews — Recent reviews

```bash
pnpm openclaw squads query reviews --squad {SQUAD_SLUG}
```

Returns: recent weekly reviews with progress ratings.

#### agents — Squad agents

```bash
pnpm openclaw squads query agents --squad {SQUAD_SLUG}
```

Returns: list of agents in the squad. Add `--status` for status info.

#### dashboard — Consolidated view

```bash
pnpm openclaw squads query dashboard --squad {SQUAD_SLUG}
```

Returns: full squad dashboard — vision, rocks, KPIs, tasks, agents in one view.

#### inbox — Leader message inbox

```bash
pnpm openclaw squads query inbox --squad {SQUAD_SLUG}
pnpm openclaw squads query inbox --squad {SQUAD_SLUG} --unread-only
```

Returns: messages from workers and NORTH. Use `--unread-only` to filter.

#### requests — Squad requests

```bash
pnpm openclaw squads query requests --squad {SQUAD_SLUG}
pnpm openclaw squads query requests --squad {SQUAD_SLUG} --status pending
```

Returns: human task requests. Filter by `--status` (pending, completed, rejected).

### Write Commands

#### create-task — Create a new task

```bash
pnpm openclaw squads query create-task --squad {SQUAD_SLUG} --goal "Research competitor pricing" --type research
pnpm openclaw squads query create-task --squad {SQUAD_SLUG} --goal "Write landing page copy" --type content --input "Use Q1 research findings"
```

Required: `--squad`, `--goal`, `--type`. Optional: `--input`, `--source`.

#### update-task — Update task status

```bash
pnpm openclaw squads query update-task --id <taskId> --status doing
pnpm openclaw squads query update-task --id <taskId> --status done --output "Completed analysis, see findings.md"
```

Required: `--id`, `--status` (todo|doing|blocked|review|done|failed). Optional: `--output`.

#### update-rock — Update rock status

```bash
pnpm openclaw squads query update-rock --id <rockId> --status in_progress
pnpm openclaw squads query update-rock --id <rockId> --status complete
```

Required: `--id`, `--status`.

#### update-kpi — Update KPI current value

```bash
pnpm openclaw squads query update-kpi --id <kpiId> --current 1500
```

Required: `--id`, `--current`.

#### create-kpi — Create a new KPI

```bash
pnpm openclaw squads query create-kpi --squad {SQUAD_SLUG} --name "Monthly Revenue" --target 10000 --direction up --unit "$"
```

Required: `--squad`, `--name`, `--target`, `--direction` (up|down). Optional: `--unit`, `--current`.

#### create-review — Create a weekly review

```bash
pnpm openclaw squads query create-review --squad {SQUAD_SLUG} --period "2026-W06" --reviewer "{LEADER_NAME}" --progress on_track --summary "All rocks progressing. KPI-3 needs attention."
```

Required: `--squad`, `--period`, `--reviewer`, `--progress` (on_track|at_risk|off_track), `--summary`. Optional: `--decisions` (JSON array).

#### link-task — Link task to a rock

```bash
pnpm openclaw squads query link-task --rock <rockId> --task <taskId>
```

Required: `--rock`, `--task`.

#### message — Send a message to a worker

```bash
pnpm openclaw squads query message --squad {SQUAD_SLUG} --agent <worker-slug> --message "Complete the competitor analysis by Friday"
pnpm openclaw squads query message --squad {SQUAD_SLUG} --agent <worker-slug> --message "Urgent: KPI breach detected" --priority urgent --trigger directive
```

Required: `--squad`, `--agent`, `--message`. Optional: `--priority` (normal|urgent|fyi), `--trigger` (directive|query|escalation|status_report|tool_result|ack).

#### mark-read — Mark messages as read

```bash
pnpm openclaw squads query mark-read --id <messageId>
pnpm openclaw squads query mark-read --all --squad {SQUAD_SLUG}
```

Either `--id` for a single message, or `--all --squad` for all unread.

#### create-request — Create a human task request

```bash
pnpm openclaw squads query create-request --squad {SQUAD_SLUG} --category "approval" --title "Approve Q2 rock list" --description "Need Pete's sign-off on proposed rocks for next quarter"
```

Required: `--squad`, `--category`, `--title`, `--description`. Optional: `--urgency` (blocking|high|medium|low), `--requested-by`, `--instructions`, `--fields` (JSON array).

#### resolve-request — Resolve a request

```bash
pnpm openclaw squads query resolve-request --id <requestId> --status completed --response '{"approved": true}'
```

Required: `--id`, `--status` (completed|rejected). Optional: `--response` (JSON).

---

## Communication with NORTH (Main Agent)

### sessions_send — Send a message to NORTH

```
sessions_send(sessionKey="agent:main:main", message="...")
```

Use this to:

- Report status updates
- Escalate issues requiring cross-squad context
- Request decisions from Pete (routed through NORTH)
- Respond to NORTH's directives

### sessions_history — Check conversation history

```
sessions_history(sessionKey="agent:main:main", limit=5)
```

Use this to review recent exchanges with NORTH.

---

## Worker Communication (leader_messages)

Workers communicate via the `leader_messages` table in Convex. I interact with it through the `message`, `inbox`, and `mark-read` commands above.

**Sending directives to workers:**

```bash
pnpm openclaw squads query message --squad {SQUAD_SLUG} --agent <worker-slug> --message "Your directive here"
```

**Reading worker responses:**

```bash
pnpm openclaw squads query inbox --squad {SQUAD_SLUG} --unread-only
```

**Message priorities:** `normal` (default), `urgent` (handle immediately), `fyi` (no action needed).

**Message triggers:** `directive` (instruction), `query` (question), `escalation` (needs attention), `status_report` (update), `tool_result` (response to tool request), `ack` (acknowledgment).

---

## File Operations

I can read and write files in my workspace using standard OpenClaw file tools:

- `read` — Read file contents
- `write` — Write or create files
- `edit` — Edit existing files

My workspace is at `~/.openclaw/agents/{SQUAD_SLUG}-leader/workspace/`.

Use files to persist decisions, plans, analysis, and anything that needs to survive across sessions.

---

## Web Tools

- `web_search` — Search the web via Brave Search API
- `web_fetch` — Fetch and extract content from URLs

Use these for research, competitive intelligence, and fact-checking. Always cite sources.
