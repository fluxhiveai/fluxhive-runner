# @fluxhive/runner

OpenClaw bridge runner for Flux MCP, branded as FluxHive Runner.

## Environment

- `FLUX_TOKEN` (required)
- `FLUX_HOST` (required)
- `FLUX_ORG_ID` (optional; when unset, derived from `GET /SKILL.md` using the token)
- `FLUX_BACKEND` (optional filter: `pi` | `claude-cli` | `codex-cli`)
- `OPENCLAW_GATEWAY_URL` (optional; when set, enables the OpenClaw gateway backend)
- `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` (optional, based on gateway auth mode)
- `OPENCLAW_AGENT_ID` (optional)
- `FLUX_PI_AGENT_DIR` (optional, default `~/.flux/pi-agent`; expects `models.json`, optional `auth.json`)
- `FLUX_CADENCE_MINUTES` (optional, default `15`)
- `FLUX_PUSH_RECONNECT_MS` (optional, default `5000`)
- `FLUX_ALLOW_DIRECT_CLI` (optional; set to `1` to allow direct `claude-cli` execution even when OpenClaw is configured)

## Run

```bash
pnpm -C packages/runner build
pnpm -C packages/runner start
```
