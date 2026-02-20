/**
 * Service management for persistent runner installation.
 *
 * Provides install/restart/stop/uninstall/status commands for running the
 * FluxHive runner as a system service that auto-starts on boot and
 * auto-restarts on crash. Supports two platforms:
 *
 *   - macOS: launchd user agent (~/Library/LaunchAgents/ai.fluxhive.runner.plist)
 *   - Linux: systemd user service (~/.config/systemd/user/fluxhive-runner.service)
 *
 * The service captures current FLUX_* and OPENCLAW_* env vars and bakes them
 * into the service definition. A minimal PATH is constructed to ensure the
 * service can find node regardless of shell initialization (covers nvm, pnpm,
 * volta, asdf, fnm, bun, and system paths).
 *
 * Logs are written to ~/.flux/logs/runner.log and ~/.flux/logs/runner.err.log.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join, resolve, dirname, basename, posix, delimiter } from "node:path";
import { homedir, platform } from "node:os";
import process from "node:process";
import { FluxMcpClient } from "./client.js";

const LABEL = "ai.fluxhive.runner";
const SYSTEMD_SERVICE_NAME = "fluxhive-runner";
const LOG_DIR = join(homedir(), ".flux", "logs");
const STDOUT_LOG = join(LOG_DIR, "runner.log");
const STDERR_LOG = join(LOG_DIR, "runner.err.log");

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

type ServicePlatform = "launchd" | "systemd";

function detectPlatform(): ServicePlatform {
  if (platform() === "darwin") return "launchd";
  if (platform() === "linux") return "systemd";
  throw new Error(
    `Unsupported platform: ${platform()}. Only macOS (launchd) and Linux (systemd) are supported.`,
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Resolves the path to the bundled fluxhive CLI.
 *  - Standalone bundle (e.g. ~/.flux/fluxhive.mjs): returns its own path.
 *  - Repo bundle (dist/fluxhive.mjs): returns its own path (same file).
 *  - tsc output (dist/runner/service.js): resolves to <packageRoot>/dist/fluxhive.mjs. */
function getRunnerEntrypoint(): string {
  const thisFile = new URL(import.meta.url).pathname;
  // If we ARE the bundle (filename is fluxhive.mjs), point to ourselves
  if (basename(thisFile) === "fluxhive.mjs") return thisFile;
  // Otherwise fall back to repo-relative resolution (dev/tsc mode)
  const thisDir = dirname(thisFile);
  const packageRoot = thisDir.endsWith("/runner")
    ? resolve(thisDir, "..", "..")
    : resolve(thisDir, "..");
  const entrypoint = resolve(packageRoot, "dist", "fluxhive.mjs");
  if (!existsSync(entrypoint)) {
    console.warn(
      `Warning: bundled entrypoint not found at ${entrypoint}\n` +
      `  Run 'pnpm bundle' in the fluxhive package to create it.\n` +
      `  ('pnpm build' only runs tsc — the service requires the bundle.)`,
    );
  }
  return entrypoint;
}

function getNodePath(): string {
  return process.execPath;
}

function ensureFluxDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  // pi-agent-core reads package.json from the bundle's directory at import time.
  // When running standalone from ~/.flux/, we need a stub so it doesn't crash.
  const fluxDir = join(homedir(), ".flux");
  const stubPkg = join(fluxDir, "package.json");
  if (!existsSync(stubPkg)) {
    writeFileSync(stubPkg, JSON.stringify({ name: "fluxhive-runner", version: "0.0.0", type: "module" }) + "\n");
  }
}

function resolveGuiDomain(): string {
  if (typeof process.getuid === "function") return `gui/${process.getuid()}`;
  return "gui/501";
}

// Build a minimal PATH suitable for service environments (launchd / systemd).
// Mirrors OpenClaw's buildMinimalServicePath — includes nvm, pnpm, volta, asdf,
// fnm, bun, and system paths so the service can find node even without a shell.
function buildMinimalServicePath(): string {
  const home = homedir();
  const parts: string[] = [];
  const add = (dir: string | undefined) => {
    if (dir && !parts.includes(dir)) parts.push(dir);
  };

  // Current node's bin directory (most important — ensures the right node is found)
  add(dirname(process.execPath));

  // Version manager and user bin dirs
  add(process.env.PNPM_HOME);
  add(process.env.NVM_DIR ? posix.join(process.env.NVM_DIR, "current", "bin") : undefined);
  add(process.env.FNM_DIR ? posix.join(process.env.FNM_DIR, "current", "bin") : undefined);
  add(process.env.VOLTA_HOME ? posix.join(process.env.VOLTA_HOME, "bin") : undefined);
  add(process.env.ASDF_DATA_DIR ? posix.join(process.env.ASDF_DATA_DIR, "shims") : undefined);
  add(process.env.BUN_INSTALL ? posix.join(process.env.BUN_INSTALL, "bin") : undefined);
  add(process.env.NPM_CONFIG_PREFIX ? posix.join(process.env.NPM_CONFIG_PREFIX, "bin") : undefined);
  add(`${home}/Library/pnpm`);
  add(`${home}/.local/bin`);
  add(`${home}/.npm-global/bin`);
  add(`${home}/bin`);
  add(`${home}/.nvm/current/bin`);
  add(`${home}/.fnm/current/bin`);
  add(`${home}/.fnm/aliases/default/bin`);
  add(`${home}/Library/Application Support/fnm/aliases/default/bin`);
  add(`${home}/.volta/bin`);
  add(`${home}/.asdf/shims`);
  add(`${home}/.local/share/pnpm`);
  add(`${home}/.bun/bin`);

  // System paths
  if (platform() === "darwin") {
    add("/opt/homebrew/bin");
  }
  add("/usr/local/bin");
  add("/usr/bin");
  add("/bin");

  return parts.join(delimiter);
}

const ENV_KEYS = [
  "FLUX_TOKEN",
  "FLUX_HOST",
  "FLUX_ORG_ID",
  "FLUX_CADENCE_MINUTES",
  "FLUX_RUNNER_TYPE",
  "FLUX_RUNNER_VERSION",
  "FLUX_RUNNER_ID",
  "FLUX_MACHINE_ID",
  "FLUX_BACKEND",
  "FLUX_ALLOW_DIRECT_CLI",
  "FLUX_PUSH_RECONNECT_MS",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_AGENT_ID",
];

/** Reads ~/.flux/config.json (written by `access redeem`). */
function readConfigFile(): { host?: string; token?: string; orgId?: string } | null {
  try {
    const raw = readFileSync(join(homedir(), ".flux", "config.json"), "utf8");
    return JSON.parse(raw) as { host?: string; token?: string; orgId?: string };
  } catch {
    return null;
  }
}

/** Collects all FLUX_* and OPENCLAW_* env vars that are currently set,
 *  falling back to ~/.flux/config.json for token, host, and orgId. */
function collectEnvVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const val = process.env[key]?.trim();
    if (val) vars[key] = val;
  }
  // Fall back to config file for core credentials (written by `access redeem`)
  if (!vars.FLUX_TOKEN || !vars.FLUX_HOST) {
    const config = readConfigFile();
    if (config) {
      if (!vars.FLUX_TOKEN && config.token) vars.FLUX_TOKEN = config.token;
      if (!vars.FLUX_HOST && config.host) vars.FLUX_HOST = config.host;
      if (!vars.FLUX_ORG_ID && config.orgId) vars.FLUX_ORG_ID = config.orgId;
    }
  }
  return vars;
}

/** Applies default values: 1-minute cadence, auto-detect OpenClaw gateway port. */
function applyDefaults(envVars: Record<string, string>): void {
  if (!envVars.FLUX_CADENCE_MINUTES) {
    envVars.FLUX_CADENCE_MINUTES = "1";
  }
  if (!envVars.OPENCLAW_GATEWAY_URL) {
    const openclawConfig = join(homedir(), ".openclaw", "openclaw.json");
    if (existsSync(openclawConfig)) {
      try {
        const config = JSON.parse(
          readFileSync(openclawConfig, "utf8"),
        ) as Record<string, unknown>;
        const gw = config.gateway as Record<string, unknown> | undefined;
        const port = gw?.port ?? 18789;
        envVars.OPENCLAW_GATEWAY_URL = `ws://127.0.0.1:${port}`;
      } catch {
        // ignore
      }
    }
  }
}

function validateEnvVars(envVars: Record<string, string>): void {
  if (!envVars.FLUX_TOKEN) {
    console.error(
      "Error: FLUX_TOKEN is required. Set FLUX_TOKEN env var or run 'fluxhive access redeem' first.",
    );
    process.exit(1);
  }
  if (!envVars.FLUX_HOST) {
    console.error(
      "Error: FLUX_HOST is required. Set FLUX_HOST env var or run 'fluxhive access redeem' first.",
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// macOS launchd (uses bootstrap/bootout/kickstart — modern launchctl API)
// ---------------------------------------------------------------------------

const PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${LABEL}.plist`,
);

function plistEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Generates the launchd plist XML for the runner service. */
function buildPlist(envVars: Record<string, string>): string {
  const nodePath = getNodePath();
  const entrypoint = getRunnerEntrypoint();

  const envEntries = {
    HOME: homedir(),
    PATH: buildMinimalServicePath(),
    ...envVars,
  };

  const envXml = Object.entries(envEntries)
    .filter(([, v]) => typeof v === "string" && v.trim())
    .map(
      ([k, v]) =>
        `\n    <key>${plistEscape(k)}</key>\n    <string>${plistEscape(v.trim())}</string>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${plistEscape(LABEL)}</string>
    <key>Comment</key>
    <string>FluxHive Runner</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProgramArguments</key>
    <array>
      <string>${plistEscape(nodePath)}</string>
      <string>${plistEscape(entrypoint)}</string>
      <string>daemon</string>
    </array>
    <key>StandardOutPath</key>
    <string>${plistEscape(STDOUT_LOG)}</string>
    <key>StandardErrorPath</key>
    <string>${plistEscape(STDERR_LOG)}</string>
    <key>EnvironmentVariables</key>
    <dict>${envXml}
    </dict>
  </dict>
</plist>
`;
}

function execLaunchctl(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`launchctl ${args.join(" ")} 2>&1`, {
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status ?? 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
    };
  }
}

function launchdInstall(envVars: Record<string, string>): void {
  ensureFluxDir();

  const domain = resolveGuiDomain();
  const plist = buildPlist(envVars);

  // Ensure LaunchAgents directory exists
  const laDir = dirname(PLIST_PATH);
  if (!existsSync(laDir)) mkdirSync(laDir, { recursive: true });

  // Unload any existing instance (bootout + legacy unload)
  execLaunchctl(["bootout", domain, PLIST_PATH]);
  execLaunchctl(["unload", PLIST_PATH]);

  // Write plist and load
  writeFileSync(PLIST_PATH, plist, { mode: 0o644 });
  execLaunchctl(["enable", `${domain}/${LABEL}`]);
  const boot = execLaunchctl(["bootstrap", domain, PLIST_PATH]);
  if (boot.code !== 0) {
    // Fallback to legacy load
    const load = execLaunchctl(["load", PLIST_PATH]);
    if (load.code !== 0) {
      throw new Error(
        `launchctl load failed: ${load.stderr || load.stdout}`.trim(),
      );
    }
  }

  // Kick start to ensure it's running
  execLaunchctl(["kickstart", "-k", `${domain}/${LABEL}`]);

  console.log(`Installed and loaded ${LABEL}`);
  console.log(`  Plist: ${PLIST_PATH}`);
  console.log(`  Logs:  ${STDOUT_LOG}`);
  console.log(`         ${STDERR_LOG}`);
  console.log(`  Node:  ${getNodePath()}`);
  console.log(`  Entry: ${getRunnerEntrypoint()}`);
}

function launchdRestart(): void {
  if (!existsSync(PLIST_PATH)) {
    console.error("Error: service not installed. Run --service install first.");
    process.exit(1);
  }
  const domain = resolveGuiDomain();
  const res = execLaunchctl(["kickstart", "-k", `${domain}/${LABEL}`]);
  if (res.code !== 0) {
    // Fallback: unload + load
    execLaunchctl(["bootout", `${domain}/${LABEL}`]);
    execLaunchctl(["unload", PLIST_PATH]);
    const load = execLaunchctl(["load", PLIST_PATH]);
    if (load.code !== 0) {
      throw new Error(
        `launchctl restart failed: ${load.stderr || load.stdout}`.trim(),
      );
    }
  }
  console.log(`Restarted ${LABEL}`);
}

function launchdStop(): void {
  const domain = resolveGuiDomain();
  execLaunchctl(["bootout", `${domain}/${LABEL}`]);
  execLaunchctl(["unload", PLIST_PATH]);
  console.log(`Stopped ${LABEL}`);
}

/** Best-effort disconnect: notifies the server before uninstall.
 *  Reads FLUX_TOKEN/FLUX_HOST from env or from the installed plist/unit file. */
async function notifyDisconnect(): Promise<void> {
  const token = process.env.FLUX_TOKEN;
  const host = process.env.FLUX_HOST;
  if (!token || !host) return;
  try {
    const client = new FluxMcpClient({ baseUrl: `${host}/mcp/v1`, token });
    await client.disconnect();
    console.log("Notified server of disconnect.");
  } catch {
    // Best-effort — proceed with uninstall even if offline
  }
}

function launchdUninstall(): void {
  const domain = resolveGuiDomain();
  execLaunchctl(["bootout", `${domain}/${LABEL}`]);
  execLaunchctl(["unload", PLIST_PATH]);
  if (existsSync(PLIST_PATH)) unlinkSync(PLIST_PATH);
  console.log(`Uninstalled ${LABEL}`);
  console.log(`  Removed: ${PLIST_PATH}`);
  console.log(`  Note: config and tokens remain at ~/.flux — remove manually or re-run with --clean`);
}

function launchdStatus(): void {
  const domain = resolveGuiDomain();
  console.log(`Service: ${LABEL} (launchd)`);
  console.log(`  Plist:  ${existsSync(PLIST_PATH) ? PLIST_PATH : "(not found)"}`);

  const res = execLaunchctl(["print", `${domain}/${LABEL}`]);
  if (res.code === 0) {
    const pidMatch = res.stdout.match(/pid\s*=\s*(\d+)/i);
    const stateMatch = res.stdout.match(/state\s*=\s*(\S+)/i);
    console.log(`  State:  ${stateMatch?.[1] ?? "unknown"}`);
    if (pidMatch) console.log(`  PID:    ${pidMatch[1]}`);
  } else {
    console.log("  State:  not loaded");
  }
  printRecentLogs();
}

// ---------------------------------------------------------------------------
// Linux systemd (user-level, no sudo needed)
// These functions are only reachable on Linux and cannot be exercised in
// macOS-only test environments.
// ---------------------------------------------------------------------------

/* v8 ignore start */
const SYSTEMD_UNIT = `${SYSTEMD_SERVICE_NAME}.service`;

function systemdUnitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function systemdUnitPath(): string {
  return join(systemdUnitDir(), SYSTEMD_UNIT);
}

function systemdEscapeArg(value: string): string {
  if (!/[\s"\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Generates the systemd unit file content for the runner service. */
function buildSystemdUnit(envVars: Record<string, string>): string {
  const nodePath = getNodePath();
  const entrypoint = getRunnerEntrypoint();
  const execStart = `${systemdEscapeArg(nodePath)} ${systemdEscapeArg(entrypoint)} daemon`;

  const envLines = Object.entries({
    HOME: homedir(),
    PATH: buildMinimalServicePath(),
    ...envVars,
  })
    .filter(([, v]) => typeof v === "string" && v.trim())
    .map(
      ([k, v]) => `Environment=${systemdEscapeArg(`${k}=${v.trim()}`)}`,
    );

  return [
    "[Unit]",
    "Description=FluxHive Runner",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${execStart}`,
    "Restart=always",
    "RestartSec=5",
    "KillMode=process",
    `StandardOutput=append:${STDOUT_LOG}`,
    `StandardError=append:${STDERR_LOG}`,
    ...envLines,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function execSystemctl(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`systemctl ${args.join(" ")} 2>&1`, {
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status ?? 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
    };
  }
}

function systemdInstall(envVars: Record<string, string>): void {
  ensureFluxDir();
  const unitDir = systemdUnitDir();
  if (!existsSync(unitDir)) mkdirSync(unitDir, { recursive: true });

  const unit = buildSystemdUnit(envVars);
  writeFileSync(systemdUnitPath(), unit, { mode: 0o644 });

  const reload = execSystemctl(["--user", "daemon-reload"]);
  if (reload.code !== 0) {
    throw new Error(
      `systemctl daemon-reload failed: ${reload.stderr || reload.stdout}`.trim(),
    );
  }

  const enable = execSystemctl(["--user", "enable", SYSTEMD_UNIT]);
  if (enable.code !== 0) {
    throw new Error(
      `systemctl enable failed: ${enable.stderr || enable.stdout}`.trim(),
    );
  }

  const restart = execSystemctl(["--user", "restart", SYSTEMD_UNIT]);
  if (restart.code !== 0) {
    throw new Error(
      `systemctl restart failed: ${restart.stderr || restart.stdout}`.trim(),
    );
  }

  // Enable linger so user services persist after logout
  try {
    const user = process.env.USER || process.env.LOGNAME || "";
    if (user) {
      execSync(`loginctl enable-linger ${user} 2>/dev/null`, {
        encoding: "utf8",
      });
    }
  } catch {
    // linger is optional — may require sudo on some distros
  }

  console.log(`Installed and started ${SYSTEMD_UNIT}`);
  console.log(`  Unit:  ${systemdUnitPath()}`);
  console.log(`  Logs:  ${STDOUT_LOG}`);
  console.log(`         ${STDERR_LOG}`);
  console.log(`  Node:  ${getNodePath()}`);
  console.log(`  Entry: ${getRunnerEntrypoint()}`);
}

function systemdRestart(): void {
  if (!existsSync(systemdUnitPath())) {
    console.error("Error: service not installed. Run --service install first.");
    process.exit(1);
  }
  const res = execSystemctl(["--user", "restart", SYSTEMD_UNIT]);
  if (res.code !== 0) {
    throw new Error(
      `systemctl restart failed: ${res.stderr || res.stdout}`.trim(),
    );
  }
  console.log(`Restarted ${SYSTEMD_UNIT}`);
}

function systemdStop(): void {
  const res = execSystemctl(["--user", "stop", SYSTEMD_UNIT]);
  if (res.code !== 0 && !res.stdout.includes("not loaded")) {
    throw new Error(
      `systemctl stop failed: ${res.stderr || res.stdout}`.trim(),
    );
  }
  console.log(`Stopped ${SYSTEMD_UNIT}`);
}

function systemdUninstall(): void {
  execSystemctl(["--user", "stop", SYSTEMD_UNIT]);
  execSystemctl(["--user", "disable", SYSTEMD_UNIT]);
  if (existsSync(systemdUnitPath())) unlinkSync(systemdUnitPath());
  execSystemctl(["--user", "daemon-reload"]);
  console.log(`Uninstalled ${SYSTEMD_UNIT}`);
  console.log(`  Removed: ${systemdUnitPath()}`);
  console.log(`  Note: config and tokens remain at ~/.flux — remove manually or re-run with --clean`);
}

function systemdStatus(): void {
  console.log(`Service: ${SYSTEMD_UNIT} (systemd --user)`);
  console.log(
    `  Unit:   ${existsSync(systemdUnitPath()) ? systemdUnitPath() : "(not found)"}`,
  );
  const res = execSystemctl(["--user", "status", SYSTEMD_UNIT]);
  const output = res.stdout || res.stderr;
  if (output) {
    for (const line of output.split("\n").slice(0, 6)) {
      console.log(`  ${line}`);
    }
  } else {
    console.log("  (not running)");
  }
  printRecentLogs();
}
/* v8 ignore stop */

// ---------------------------------------------------------------------------
// Shared log tail
// ---------------------------------------------------------------------------

function printRecentLogs(): void {
  for (const [label, path] of [
    ["stderr", STDERR_LOG],
    ["stdout", STDOUT_LOG],
  ] as const) {
    if (existsSync(path)) {
      try {
        const tail = execSync(`tail -5 "${path}" 2>/dev/null`, {
          encoding: "utf8",
        }).trim();
        if (tail) {
          console.log(`  Recent ${label}:`);
          for (const line of tail.split("\n")) {
            console.log(`    ${line}`);
          }
        }
      } catch {
        // ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatches a --service subcommand (install, restart, stop, uninstall, status).
 * Detects the platform and delegates to the appropriate launchd/systemd handler.
 * Always exits the process after completion.
 */
export function handleServiceCommand(action: string, opts?: { clean?: boolean }): never {
  const plat = detectPlatform();

  if (action === "install") {
    const envVars = collectEnvVars();
    validateEnvVars(envVars);
    applyDefaults(envVars);
    if (plat === "launchd") {
      launchdInstall(envVars);
    } else {
      systemdInstall(envVars);
    }
  } else if (action === "restart") {
    if (plat === "launchd") launchdRestart();
    else systemdRestart();
  } else if (action === "stop") {
    if (plat === "launchd") launchdStop();
    else systemdStop();
  } else if (action === "uninstall") {
    // Notify server of disconnect before removing the service (best-effort, then exit)
    void notifyDisconnect().finally(() => {
      if (plat === "launchd") launchdUninstall();
      else systemdUninstall();
      if (opts?.clean) {
        const fluxDir = join(homedir(), ".flux");
        if (existsSync(fluxDir)) {
          rmSync(fluxDir, { recursive: true, force: true });
          console.log(`Removed ${fluxDir} (config, tokens, logs)`);
        }
      }
      process.exit(0);
    });
    // Keep the event loop alive while the async disconnect runs
    setTimeout(() => process.exit(1), 15_000);
    // TypeScript needs a `never` return — the above paths always exit
    return undefined as never;
  } else if (action === "status") {
    if (plat === "launchd") launchdStatus();
    else systemdStatus();
  } else {
    console.error(`Unknown service action: ${action}`);
    console.error(
      "Usage: --service install|restart|stop|uninstall|status",
    );
    process.exit(1);
  }

  process.exit(0);
}
