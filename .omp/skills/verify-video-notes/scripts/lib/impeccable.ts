/**
 * The `impeccable` detector/seed engine, shared by `verify detect` and
 * `verify prototype`.
 *
 * Resolution order: `IMPECCABLE_BIN`, then the machine's installed build
 * (`/Users/link/.impeccable/bin/0.1.18/impeccable`), then `impeccable` on
 * `PATH`. `null` means this machine cannot run the gate at all — the caller
 * decides whether that is a skip (a CI runner without `~/.impeccable`) or a
 * failure (a local dev/verify machine, where the gate is mandatory).
 *
 * Findings: `detect --json` prints an array. An **advisory** item carries
 * `severity: "advisory"` (or `advisory: true`) and never blocks; every other
 * item is **primary** (`error` / `warning` / `high`) and fails the gate.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const DEFAULT_IMPECCABLE_BIN = "/Users/link/.impeccable/bin/0.1.18/impeccable";

export interface ImpeccableFinding {
  antipattern?: string;
  name?: string;
  description?: string;
  message?: string;
  severity?: string;
  advisory?: boolean;
  category?: string;
  file?: string;
  line?: number;
  snippet?: string;
  selector?: string;
  value?: string;
}

export interface ImpeccableRun {
  exitStatus: number;
  stdout: string;
  stderr: string;
}

export function resolveImpeccableBin(): string | null {
  for (const candidate of [process.env.IMPECCABLE_BIN, DEFAULT_IMPECCABLE_BIN, "impeccable"]) {
    if (!candidate) continue;
    if (candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const found = Bun.which(candidate);
    if (found) return found;
  }
  return null;
}

export function runImpeccable(bin: string, args: string[], cwd?: string, timeoutMs = 180_000): ImpeccableRun {
  const child = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: process.env,
  });
  return {
    exitStatus: child.status ?? -1,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
}

/** `detect --json` prints one array; a scan that cannot load prints nothing and exits non-zero. */
export function parseFindings(stdout: string): ImpeccableFinding[] {
  const text = stdout.trim();
  if (text.length === 0) return [];
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error("impeccable detect --json did not print a JSON array");
  return parsed as ImpeccableFinding[];
}

export function classifyFindings(findings: ImpeccableFinding[]): {
  primary: ImpeccableFinding[];
  advisory: ImpeccableFinding[];
} {
  const primary: ImpeccableFinding[] = [];
  const advisory: ImpeccableFinding[] = [];
  for (const finding of findings) {
    if (finding.advisory === true || finding.severity === "advisory") advisory.push(finding);
    else primary.push(finding);
  }
  return { primary, advisory };
}

/**
 * Drop repeat findings (same rule + location + text) that the static and the
 * CDP scan both report; first occurrence wins, order preserved.
 */
export function dedupeFindings(findings: ImpeccableFinding[]): ImpeccableFinding[] {
  const seen = new Set<string>();
  const out: ImpeccableFinding[] = [];
  for (const finding of findings) {
    const key = JSON.stringify([
      finding.antipattern ?? finding.name ?? "",
      finding.file ?? "",
      finding.line ?? 0,
      finding.severity ?? "",
      finding.snippet ?? "",
      finding.selector ?? "",
      finding.message ?? "",
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}
