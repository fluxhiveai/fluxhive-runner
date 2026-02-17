import { appendFileSync } from "node:fs";

const FLUX_LOG_PATH = "/tmp/flux.log";
const MAJOR_DIVIDER = "=".repeat(120);
const MINOR_DIVIDER = "-".repeat(120);
const DEFAULT_PREVIEW_CHARS = 1200;

type FluxLogSection = {
  label: string;
  content?: string;
};

type FluxLogEntry = {
  stage: "INPUT" | "OUTPUT" | "ERROR";
  metadata: Record<string, string | number | boolean | undefined>;
  sections: FluxLogSection[];
};

function normalizeContent(value: string | undefined): string {
  if (value === undefined) {
    return "(empty)";
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : "(empty)";
}

export function formatLogPreview(
  value: string | undefined,
  maxChars = DEFAULT_PREVIEW_CHARS,
): string {
  const normalized = normalizeContent(value);
  if (normalized === "(empty)" || normalized.length <= maxChars) {
    return normalized;
  }
  const omitted = normalized.length - maxChars;
  return `${normalized.slice(0, maxChars)}\n...[truncated ${omitted} chars]`;
}

export function appendFluxLog(entry: FluxLogEntry): void {
  try {
    const ts = new Date().toISOString();
    const metadataLines = Object.entries(entry.metadata)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${String(value)}`);
    const sectionBlocks = entry.sections.map((section) => {
      return `${section.label}:\n${normalizeContent(section.content)}`;
    });

    const lines = [
      "",
      MAJOR_DIVIDER,
      `[${ts}] FLUX ${entry.stage}`,
      MINOR_DIVIDER,
      ...metadataLines,
      MINOR_DIVIDER,
      ...sectionBlocks,
      MAJOR_DIVIDER,
      "",
    ];
    appendFileSync(FLUX_LOG_PATH, lines.join("\n"));
  } catch {
    // Intentionally swallow filesystem errors to avoid impacting task execution.
  }
}
