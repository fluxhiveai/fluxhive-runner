# Leader Agent Templates

Templates for bootstrapping squad leader agents. Each squad gets a leader — an OpenClaw sub-agent that coordinates workers, tracks rocks/KPIs, and reports to NORTH (the main agent).

## Template Files

| File                 | Purpose                                                         | OpenClaw Equivalent |
| -------------------- | --------------------------------------------------------------- | ------------------- |
| `leader-soul.md`     | Core behavioral principles, operating style, decision framework | `SOUL.md`           |
| `leader-identity.md` | Name, creature, vibe, emoji, role, response style               | `IDENTITY.md`       |
| `leader-tools.md`    | All available tools with usage examples                         | `TOOLS.md`          |
| `leader-agents.md`   | Operating procedures, safety rules, scope boundaries            | `AGENTS.md`         |
| `leader-user.md`     | Info about Pete (the human operator)                            | `USER.md`           |
| `leader-memory.md`   | Initial memory state with squad context                         | `MEMORY.md`         |

## Variables

Templates use `{BRACES}` for values filled per-squad at bootstrap time.

### Required Variables

| Variable          | Description                                      | Example                               |
| ----------------- | ------------------------------------------------ | ------------------------------------- |
| `{LEADER_NAME}`   | Unique name from LEADER_NAMES pool               | `AEGIS`                               |
| `{SQUAD_NAME}`    | Human-readable squad name                        | `Informatica`                         |
| `{SQUAD_SLUG}`    | URL-safe squad identifier                        | `informatica`                         |
| `{SQUAD_ID}`      | Convex document ID                               | `j57x...`                             |
| `{SQUAD_PURPOSE}` | 1-2 paragraph description of what the squad does |                                       |
| `{SQUAD_DOMAIN}`  | Short domain label                               | `info products and digital education` |

### Identity Variables

| Variable               | Description                       | Example                     |
| ---------------------- | --------------------------------- | --------------------------- |
| `{LEADER_CREATURE}`    | Animal/mythical creature metaphor | `Phoenix`                   |
| `{LEADER_VIBE}`        | 2-3 word personality descriptor   | `Sovereign, strategic`      |
| `{LEADER_EMOJI}`       | Single emoji                      | `🔥`                        |
| `{LEADER_CATCHPHRASE}` | Signature opening line            | `Here's what I'm seeing...` |

### Memory Variables

| Variable           | Description                           | Example                                     |
| ------------------ | ------------------------------------- | ------------------------------------------- |
| `{BOOTSTRAP_DATE}` | Date the leader was created           | `2026-02-09`                                |
| `{SQUAD_VISION}`   | Vision statement from Convex          |                                             |
| `{ROCK_LIST}`      | Formatted list of current rocks       | `1. Rock: Launch MVP — Status: in_progress` |
| `{KPI_LIST}`       | Formatted list of KPI IDs and targets | `- Monthly Revenue: $0 / $10,000 (up)`      |
| `{AGENT_LIST}`     | Formatted list of worker agents       | `- bloodhound: Research & Analysis`         |

## Bootstrap Process

When a new squad is created, the leader gets bootstrapped in 5 steps:

### Step 1: Create the OpenClaw agent

```bash
openclaw agents add <squad-slug>-leader
```

### Step 2: Fill template variables

Query Convex for squad data (vision, rocks, KPIs, agents) and populate all `{VARIABLES}` in each template.

### Step 3: Write files to the agent workspace

Copy the filled templates into the agent's OpenClaw directory:

```
~/.openclaw/agents/<squad-slug>-leader/
  SOUL.md        ← from leader-soul.md
  IDENTITY.md    ← from leader-identity.md
  TOOLS.md       ← from leader-tools.md
  AGENTS.md      ← from leader-agents.md
  USER.md        ← from leader-user.md
  memory/
    MEMORY.md    ← from leader-memory.md
```

### Step 4: Register in Convex

Update the squad record with `leaderAgentId` and `leaderStatus: "active"`.

### Step 5: Notify NORTH

Send a message to NORTH: "New squad leader {LEADER_NAME} is online for {SQUAD_NAME}. Ready for initial briefing."

## Customization

Templates provide the operational baseline. Per-squad customization happens in two ways:

1. **At bootstrap:** Domain-specific content goes into `{SQUAD_PURPOSE}` and `{SQUAD_DOMAIN}` variables. The soul adapts to any domain through these.

2. **After bootstrap:** The leader evolves its own MEMORY.md through operation. Decisions, lessons learned, and squad-specific procedures accumulate over time.

## Design Principles

- **Operational, not fluffy.** Every section tells the agent what to do, not just who to be.
- **Hierarchy-respecting.** Leaders go through NORTH, never directly to Pete.
- **Self-contained.** A leader should be able to start a session and know exactly what to do from these files alone.
- **Memory-aware.** Templates assume the agent has no memory between sessions. Everything important gets written to files.
