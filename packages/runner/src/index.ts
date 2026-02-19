/* eslint-disable no-console */
import process from "node:process";
import { handleServiceCommand } from "./service.js";
import { loadRunnerConfig } from "./config.js";
import { FluxMcpClient } from "./client.js";
import { OpenClawClient } from "./openclaw.js";
import { FluxPushClient } from "./push.js";
import { TaskExecutor } from "./executor.js";
import { CadenceLoop } from "./cadence.js";
import { normalizeExecutionBackend, type RunnerExecutionBackend } from "./execution.js";
import { OpenClawExecutionBackend } from "./openclaw_backend.js";
import { PiExecutionBackend } from "./pi_backend.js";
import { ClaudeCliExecutionBackend } from "./claude_cli_backend.js";

function normalizeWsUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("ws://") || value.startsWith("wss://")) return value;
  if (value.startsWith("http://")) return `ws://${value.slice("http://".length)}`;
  if (value.startsWith("https://")) return `wss://${value.slice("https://".length)}`;
  return null;
}

function log(level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(fields || {}),
  };
  const text = JSON.stringify(line);
  if (level === "error") {
    console.error(text);
  } else if (level === "warn") {
    console.warn(text);
  } else {
    console.log(text);
  }
}

async function main() {
  // Handle --service subcommand before loading config
  const serviceIdx = process.argv.indexOf("--service");
  if (serviceIdx !== -1) {
    const action = process.argv[serviceIdx + 1] || "";
    handleServiceCommand(action);
  }

  const config = await loadRunnerConfig();
  log("info", "runner.start", {
    fluxHost: config.fluxHost,
    fluxOrgId: config.fluxOrgId,
    skillManifestUrl: config.skillManifestUrl,
    runnerType: config.runnerType,
    runnerVersion: config.runnerVersion,
  });

  const fluxClient = new FluxMcpClient({
    baseUrl: config.fluxMcpBase,
    token: config.fluxToken,
  });
  const whoami = await fluxClient.whoami();
  log("info", "flux.whoami", {
    agentId: whoami.agent?.id,
    agentSlug: whoami.agent?.slug,
    serverVersion: whoami.server?.version,
  });

  const backend = process.env.FLUX_BACKEND?.trim() || undefined;
  const normalizedBackendFilter = normalizeExecutionBackend(backend);
  const handshake = await fluxClient.handshake({
    runnerType: config.runnerType,
    runnerVersion: config.runnerVersion,
    runnerInstanceId: config.runnerInstanceId,
    machineId: config.machineId,
    backend,
  });
  log("info", "flux.handshake.ok", {
    handshakeAgentId: handshake.agentId,
    handshakeAgentName: handshake.agentName,
    pushMode: handshake.config?.push?.mode || "unknown",
  });

  try {
    await fluxClient.hello();
    log("info", "flux.hello.ok");
  } catch (err) {
    log("warn", "flux.hello.skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const allowDirectCli =
    (process.env.FLUX_ALLOW_DIRECT_CLI?.trim() || "") === "1" ||
    (process.env.FLUX_ALLOW_DIRECT_CLI?.trim() || "").toLowerCase() === "true";

  const executionBackends: RunnerExecutionBackend[] = [];

  const openclawCompatibleFilter =
    !normalizedBackendFilter ||
    normalizedBackendFilter === "openclaw" ||
    normalizedBackendFilter === "claude-cli" ||
    normalizedBackendFilter === "codex-cli";
  let openclawClient: OpenClawClient | null = null;
  const openclawGatewayUrl = config.openclawGatewayUrl?.trim() || "";
  const openclawEnabled = openclawGatewayUrl.length > 0;
  if (openclawEnabled && openclawCompatibleFilter) {
    openclawClient = new OpenClawClient({
      gatewayUrl: openclawGatewayUrl,
      token: config.openclawGatewayToken,
      password: config.openclawGatewayPassword,
      defaultAgentId: config.openclawAgentId,
      clientName: "fluxhive-runner",
      clientVersion: config.runnerVersion,
      instanceId: config.runnerInstanceId,
    });
    const pingOk = await openclawClient.ping();
    if (!pingOk) {
      log("warn", "openclaw.disabled", {
        reason: "gateway_ping_failed",
        gatewayUrl: openclawGatewayUrl,
      });
      try { openclawClient.close(); } catch { /* ignore */ }
      openclawClient = null;
    } else {
      executionBackends.push(
        new OpenClawExecutionBackend({
          client: openclawClient,
          orgId: config.fluxOrgId,
          openclawAgentId: config.openclawAgentId,
        }),
      );
      log("info", "openclaw.connected", {
        gatewayUrl: openclawGatewayUrl,
        openclawAgentId: config.openclawAgentId || "default",
      });
    }
  }

  const piCompatibleFilter = !normalizedBackendFilter || normalizedBackendFilter === "pi";
  if (piCompatibleFilter) {
    const piBackend = new PiExecutionBackend();
    const preflight = await piBackend.preflight();
    if (preflight.ok) {
      executionBackends.push(piBackend);
      log("info", "pi.ready", {
        agentDir: piBackend.getAgentDir(),
      });
    } else if (normalizedBackendFilter === "pi") {
      throw new Error(`PI preflight failed: ${preflight.reason}`);
    } else {
      log("warn", "pi.disabled", {
        reason: preflight.reason,
      });
    }
  }

  const claudeCompatibleFilter = !normalizedBackendFilter || normalizedBackendFilter === "claude-cli";
  if (claudeCompatibleFilter) {
    if (openclawEnabled && !allowDirectCli) {
      log("warn", "claude_cli.disabled", {
        reason: "openclaw_present",
        hint: "Set FLUX_ALLOW_DIRECT_CLI=1 to enable direct CLI execution.",
      });
    } else if (allowDirectCli) {
      executionBackends.push(new ClaudeCliExecutionBackend());
      log("info", "claude_cli.enabled");
    }
  }

  if (executionBackends.length === 0) {
    throw new Error(
      `No execution backend registered for FLUX_BACKEND=${normalizedBackendFilter ?? "(unset)"}.`,
    );
  }

  const executor = new TaskExecutor({
    fluxClient,
    executionBackends,
    runnerType: config.runnerType,
    runnerVersion: config.runnerVersion,
    runnerInstanceId: config.runnerInstanceId,
    machineId: config.machineId,
    backend,
    heartbeatMs: 30_000,
  });

  const cadence = new CadenceLoop({
    client: fluxClient,
    executor,
    intervalMs: config.cadenceMinutes * 60_000,
    listLimit: Math.max(1, handshake.config?.maxBatchSize ?? 10),
    backend,
    onError: (error) => {
      log("error", "cadence.tick.error", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const pushWsUrl = normalizeWsUrl(handshake.config?.push?.wsUrl || config.skillManifestFrontmatter.mcpPushWs);
  const pushMode = handshake.config?.push?.mode;
  let pushClient: FluxPushClient | null = null;
  if (pushMode !== "polling" && pushWsUrl) {
    pushClient = new FluxPushClient({
      wsUrl: pushWsUrl,
      fluxClient,
      reconnectBaseMs: config.pushReconnectMs,
      runnerType: config.runnerType,
      runnerVersion: config.runnerVersion,
      runnerInstanceId: config.runnerInstanceId,
      machineId: config.machineId,
      backend,
    });
    pushClient.on("connected", () => {
      log("info", "push.connected", { wsUrl: pushWsUrl });
    });
    pushClient.on("disconnected", () => {
      log("warn", "push.disconnected");
    });
    pushClient.on("error", (error) => {
      log("warn", "push.error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    pushClient.on("task.available", () => {
      cadence.triggerNow();
    });
    await pushClient.start();
  } else {
    log("warn", "push.disabled", {
      reason: pushMode === "polling" ? "push_mode_polling" : "no_ws_url",
    });
  }

  cadence.start();
  log("info", "runner.ready", {
    cadenceMinutes: config.cadenceMinutes,
  });

  const shutdown = async (signal: string) => {
    log("info", "runner.shutdown", { signal });
    cadence.stop();
    pushClient?.stop();
    openclawClient?.close();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT").finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").finally(() => process.exit(0));
  });

  // Keep process alive while interval/push loops run.
  await new Promise<void>(() => {
    // no-op
  });
}

main().catch((error) => {
  log("error", "runner.fatal", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
