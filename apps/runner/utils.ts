import os from "node:os";
import path from "node:path";

/**
 * Resolve a user-supplied path by expanding `~` and returning an absolute path.
 */
export function resolveUserPath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed.length === 0) {
    return path.resolve(trimmed);
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}
