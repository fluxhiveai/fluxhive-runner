#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runnerRoot = path.resolve(__dirname, "..");

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function resolveOutfile() {
  const raw = getArg("--outfile") || getArg("-o");
  if (!raw) return path.resolve(runnerRoot, "dist/flux-runner.mjs");
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(runnerRoot, raw);
}

async function main() {
  const outfile = resolveOutfile();
  const entry = path.resolve(runnerRoot, "src/index.ts");

  await build({
    entryPoints: [entry],
    outfile,
    platform: "node",
    format: "esm",
    target: "node20",
    bundle: true,
    packages: "bundle",
    sourcemap: false,
    logLevel: "info",
    banner: {
      js: "#!/usr/bin/env node",
    },
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

