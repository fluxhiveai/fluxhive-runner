/**
 * Output formatting helpers.
 *
 * Human-readable tables by default, JSON with --json flag.
 * Raw ANSI codes — no chalk/ora dependencies.
 * Respects NO_COLOR convention and non-TTY environments.
 */
import process from "node:process";

const isTTY = process.stdout.isTTY === true;
const noColor = "NO_COLOR" in process.env;
const useColor = isTTY && !noColor;

function ansi(code: string, text: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export function bold(text: string): string {
  return ansi("1", text);
}

export function dim(text: string): string {
  return ansi("2", text);
}

export function green(text: string): string {
  return ansi("32", text);
}

export function red(text: string): string {
  return ansi("31", text);
}

export function yellow(text: string): string {
  return ansi("33", text);
}

export function cyan(text: string): string {
  return ansi("36", text);
}

/** Print an error message to stderr and exit. */
export function error(message: string): never {
  console.error(red(`Error: ${message}`));
  process.exit(1);
}

/** Print JSON to stdout. */
export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/** Print a simple key-value list. */
export function keyValue(pairs: Array<[string, string | undefined]>): void {
  const maxKey = Math.max(...pairs.map(([k]) => k.length));
  for (const [key, value] of pairs) {
    console.log(`  ${bold(key.padEnd(maxKey))}  ${value ?? dim("(none)")}`);
  }
}

/** Print a table with headers and rows. */
export function table(
  headers: string[],
  rows: string[][],
): void {
  if (rows.length === 0) {
    console.log(dim("  (no results)"));
    return;
  }

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );

  const header = headers.map((h, i) => bold(h.padEnd(widths[i]))).join("  ");
  const separator = widths.map((w) => dim("-".repeat(w))).join("  ");

  console.log(`  ${header}`);
  console.log(`  ${separator}`);
  for (const row of rows) {
    const line = row.map((cell, i) => (cell ?? "").padEnd(widths[i])).join("  ");
    console.log(`  ${line}`);
  }
}

/** Truncate a string to a maximum length. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
