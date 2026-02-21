# FluxHive Runner

FluxHive Runner is a lightweight daemon that connects an OpenClaw gateway to a Flux MCP backend.

It claims tasks, executes them via OpenClaw, and reports results back to Flux.

This repo ships a **single-file executable** (`fluxhive-runner.mjs`) via GitHub Releases for easy installation and updates on macOS and Linux.

## Download (Latest)

Release assets:

- `fluxhive.mjs`
- `fluxhive.mjs.sha256`

Always verify the checksum after downloading:

```bash
shasum -a 256 -c fluxhive.mjs.sha256
```

## Run

Environment variables:

- `FLUX_HOST` (Flux Convex Site origin, e.g. `https://<deployment>.convex.site`)
- `FLUX_TOKEN` (MCP bearer token)
- `OPENCLAW_GATEWAY_URL` (local OpenClaw gateway WS URL, e.g. `ws://127.0.0.1:8787/ws`)

Then:

```bash
node fluxhive-runner.mjs
```

## Development

```bash
pnpm install
pnpm test
pnpm bundle
```
