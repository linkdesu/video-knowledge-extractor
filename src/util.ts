export type ProcResult = { stdout: string; stderr: string; code: number };

export async function run(cmd: string[], opts: { stdin?: Uint8Array; allowFail?: boolean; label?: string } = {}): Promise<ProcResult> {
  const proc = Bun.spawn(cmd, {
    stdin: opts.stdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.stdin && proc.stdin) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !opts.allowFail) {
    const tail = stderr.trim().split("\n").slice(-12).join("\n");
    throw new Error(`${opts.label ?? cmd[0]} failed (exit ${code})\n${tail}`);
  }
  return { stdout, stderr, code };
}

/** Run ffmpeg and collect raw stdout bytes (for frame hashing). */
export async function runRaw(cmd: string[], onChunk?: (b: Uint8Array) => void): Promise<{ bytes: Uint8Array; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const parts: Uint8Array[] = [];
  const reader = proc.stdout.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      parts.push(value);
      total += value.byteLength;
      onChunk?.(value);
    }
  }
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`ffmpeg failed (exit ${code})\n${stderr.slice(-1200)}`);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    bytes.set(p, off);
    off += p.byteLength;
  }
  return { bytes, stderr };
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** 12.345 -> 00:00:12,345 (SRT) */
export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
}

export class Logger {
  private t0 = performance.now();
  private last = this.t0;
  constructor(private stageTotal: number) {}

  step(name: string, msg = "") {
    const now = performance.now();
    const since = ((now - this.last) / 1000).toFixed(1);
    this.last = now;
    const total = ((now - this.t0) / 1000).toFixed(1);
    console.error(`[${name}] ${msg}${msg ? " " : ""}(${since}s, total ${total}s)`);
  }

  progress(name: string, current: number, total: number, extra = "") {
    const pct = total ? ((current / total) * 100).toFixed(0) : "?";
    const width = 24;
    const filled = total ? Math.round((current / total) * width) : 0;
    const bar = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
    const elapsed = (performance.now() - this.t0) / 1000;
    const eta = current > 0 ? (elapsed / current) * (total - current) : 0;
    console.error(`[${name}] ${bar} ${current}/${total} ${pct}%${extra ? " " + extra : ""}${eta > 0 ? ` eta ${eta.toFixed(0)}s` : ""}`);
  }

  done() {
    const total = ((performance.now() - this.t0) / 1000).toFixed(1);
    console.error(`[done] pipeline ${this.stageTotal} stages in ${total}s`);
    return Number(total);
  }
}

export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function slugify(name: string): string {
  return name
    .replace(/\.(mp4|mov|mkv|webm|m4v|avi)$/i, "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "video";
}
