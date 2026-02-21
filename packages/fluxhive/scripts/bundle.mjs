#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliRoot = path.resolve(__dirname, "..");

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function resolveOutfile() {
  const raw = getArg("--outfile") || getArg("-o");
  if (!raw) return path.resolve(cliRoot, "dist/fluxhive.mjs");
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(cliRoot, raw);
}

async function main() {
  const outfile = resolveOutfile();
  const entry = path.resolve(cliRoot, "src/index.ts");
  const pkg = JSON.parse(readFileSync(path.resolve(cliRoot, "package.json"), "utf8"));

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
    define: {
      __FLUXHIVE_VERSION__: JSON.stringify(pkg.version),
    },
    banner: {
      js: [
        "#!/usr/bin/env node",
        'import { createRequire as __createRequire } from "module";',
        "const require = __createRequire(import.meta.url);",
      ].join("\n"),
    },
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
