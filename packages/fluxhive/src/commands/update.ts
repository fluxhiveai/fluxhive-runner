/**
 * `fluxhive update` — self-update the fluxhive runner binary.
 *
 * Usage:
 *   fluxhive update           Check for and install the latest version
 *   fluxhive update --check   Check for updates without installing
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, copyFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { Command } from "commander";
import { VERSION } from "../version.js";

const GITHUB_RELEASE_URL =
  "https://api.github.com/repos/fluxhiveai/fluxhive-runner/releases/latest";

/** Returns -1 if a < b, 0 if equal, 1 if a > b (numeric semver comparison). */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

export interface ReleaseInfo {
  version: string;
  assets: { name: string; url: string }[];
}

/** Fetches the latest GitHub release metadata. */
export async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const res = await fetch(GITHUB_RELEASE_URL, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string }[];
  };
  const version = data.tag_name.replace(/^v/, "");
  const assets = data.assets.map((a) => ({
    name: a.name,
    url: a.browser_download_url,
  }));
  return { version, assets };
}

/** Computes SHA-256 of a file and compares it to the expected hex hash. */
export async function verifyChecksum(
  filePath: string,
  expectedHash: string,
): Promise<boolean> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex") === expectedHash.trim().toLowerCase();
}

/** Downloads a URL to a local file path. */
async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status}): ${url}`);
  }
  if (!res.body) {
    throw new Error(`No response body from: ${url}`);
  }
  const writable = createWriteStream(dest);
  await pipeline(Readable.fromWeb(res.body as any), writable);
}

/** Resolves the path of the current bundle (the running fluxhive.mjs file). */
function resolveBundlePath(): string | null {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    if (selfPath.endsWith(".mjs")) {
      return selfPath;
    }
    // Running from tsc output (.js) — cannot self-update
    return null;
  } catch {
    return null;
  }
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Update fluxhive to the latest version")
    .option("--check", "Check for updates without installing")
    .action(async (opts: { check?: boolean }) => {
      const current = VERSION;
      console.log(`Current version: v${current}`);

      let release: ReleaseInfo;
      try {
        release = await fetchLatestRelease();
      } catch (err) {
        console.error(
          `Failed to check for updates: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }

      const cmp = compareSemver(current, release.version);
      if (cmp >= 0) {
        console.log(`Already up to date (latest: v${release.version}).`);
        return;
      }

      console.log(`New version available: v${release.version}`);

      if (opts.check) {
        return;
      }

      // Resolve the path to the running bundle
      const bundlePath = resolveBundlePath();
      if (!bundlePath) {
        console.error(
          "Cannot self-update: not running from a bundled .mjs file.\n" +
            "Run this command from the installed fluxhive.mjs binary.",
        );
        process.exit(1);
      }

      // Find the bundle and checksum assets
      const bundleAsset = release.assets.find((a) => a.name === "fluxhive.mjs");
      const checksumAsset = release.assets.find(
        (a) => a.name === "fluxhive.mjs.sha256",
      );

      if (!bundleAsset) {
        console.error(
          "Release does not contain a fluxhive.mjs asset. Update aborted.",
        );
        process.exit(1);
      }

      const dir = dirname(bundlePath);
      const tmpPath = `${dir}/fluxhive.mjs.tmp`;
      const backupPath = `${dir}/fluxhive.mjs.old`;

      try {
        // Download the new bundle
        console.log("Downloading new version...");
        await downloadFile(bundleAsset.url, tmpPath);

        // Verify checksum if available
        if (checksumAsset) {
          console.log("Verifying checksum...");
          const checksumRes = await fetch(checksumAsset.url);
          if (!checksumRes.ok) {
            throw new Error(
              `Failed to download checksum (${checksumRes.status})`,
            );
          }
          const expectedHash = (await checksumRes.text()).split(/\s/)[0];
          const valid = await verifyChecksum(tmpPath, expectedHash);
          if (!valid) {
            throw new Error(
              "Checksum verification failed. The downloaded file may be corrupted.",
            );
          }
        }

        // Backup current binary
        await copyFile(bundlePath, backupPath);

        // Atomic replace
        await rename(tmpPath, bundlePath);

        console.log(
          `Updated v${current} \u2192 v${release.version}. ` +
            "Restart the service to use the new version: fluxhive runner restart",
        );
      } catch (err) {
        console.error(
          `Update failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });
}
