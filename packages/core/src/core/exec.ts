import { spawn, type ChildProcess } from "node:child_process";
import { logger, type LogModule } from "./logger";

/**
 * 子进程执行：收 stdout/stderr；非零退出默认抛错。
 */
export type ProcResult = { stdout: string; stderr: string; code: number };

/** Human-readable digest of an ffmpeg/ffprobe argv (see {@link summarizeFfmpegArgs}). */
export type FfmpegSummary = {
  input: string | null;
  output: string | null;
  mode: "copy" | "transcode";
  videoCodec: string | null;
  audioCodec: string | null;
};

// Flags whose following token is a value, not a path (only used to find the output position)
const VALUE_TAKING_FLAGS: Record<string, true> = {
  "-q:v": true,
  "-crf": true,
  "-vf": true,
  "-map": true,
  "-c:v": true,
  "-c:a": true,
  "-b:a": true,
  "-preset": true,
  "-frames:v": true,
  "-ss": true,
};
const VIDEO_CODEC_FLAGS: Record<string, true> = { "-c:v": true, "-vcodec": true };
const AUDIO_CODEC_FLAGS: Record<string, true> = { "-c:a": true, "-acodec": true };

// True when `flag` appears anywhere with `value` as its immediate next token
function valueFollows(args: string[], flag: string, value: string): boolean {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] === value) return true;
  }
  return false;
}

// Args after `-c:v`/`-vcodec` (video) or `-c:a`/`-acodec` (audio); first occurrence wins
function codecAfter(args: string[], flags: Record<string, true>): string | null {
  for (let i = 0; i < args.length; i++) {
    if (flags[args[i]!] !== true) continue;
    const value = args[i + 1];
    return value === undefined || value.startsWith("-") ? null : value;
  }
  return null;
}

// Last token that is neither a flag nor the value of a known value-taking flag; null when absent
function lastPathArg(args: string[]): string | null {
  const consumed = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    if (VALUE_TAKING_FLAGS[args[i]!] === true && i + 1 < args.length) consumed.add(i + 1);
  }
  for (let i = args.length - 1; i >= 0; i--) {
    const token = args[i]!;
    if (token === "" || token.startsWith("-")) continue;
    if (consumed.has(i)) continue;
    return token;
  }
  return null;
}

/**
 * Digests an ffmpeg/ffprobe argv (without the binary) for logs: input file, output file,
 * copy vs transcode, and the requested codecs. Never throws; unknown shapes yield nulls.
 *
 * Output is the last non-flag token that is not the value of one of VALUE_TAKING_FLAGS,
 * which covers `-q:v 2` / `-frames:v 1` tails while keeping the scan trivial to reason about.
 */
export function summarizeFfmpegArgs(args: string[]): FfmpegSummary {
  const inputAt = args.indexOf("-i");
  const input = inputAt === -1 ? null : (args[inputAt + 1] ?? null);
  const video = codecAfter(args, VIDEO_CODEC_FLAGS);
  const audio = codecAfter(args, AUDIO_CODEC_FLAGS);
  // `-c copy` (stream copy for everything) or a per-stream copy (`-c:v copy`, `-acodec copy`, ...)
  const mode = valueFollows(args, "-c", "copy") || video === "copy" || audio === "copy" ? "copy" : "transcode";
  return {
    input,
    output: lastPathArg(args),
    mode,
    videoCodec: video === "copy" ? null : video,
    audioCodec: audio === "copy" ? null : audio,
  };
}

// Electron 取消提取时要杀掉 worker 里还在跑的 ffmpeg/ffprobe；close 后移除
const activeChildren = new Set<ChildProcess>();

/** 杀掉所有尚未 close 的子进程（SIGKILL）；用于取消提取。 */
export function killActiveChildren(): void {
  for (const child of [...activeChildren]) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } catch {
      // 已退出的进程 kill 会抛 ESRCH，忽略
    }
  }
}

export async function run(
  cmd: string[],
  opts: { label?: string; allowFail?: boolean; logModule?: LogModule; onStderrLine?: (line: string) => void } = {},
): Promise<ProcResult> {
  const [file, ...args] = cmd;
  if (file === undefined) throw new Error("run 至少需要一个命令");
  const label = opts.label ?? file;
  const mod = opts.logModule ?? "ffmpeg";
  const log = logger();
  const startedAt = Date.now();
  // 整条 argv 一次性记录，URL 内嵌的 key 也能被 redact 命中
  log.info(mod, file, { cmd });
  // ffmpeg/ffprobe: one extra human-readable summary line (this is the only place it is emitted)
  if (mod === "ffmpeg") {
    const summary = summarizeFfmpegArgs(args);
    log.info(mod, "命令摘要", {
      input: summary.input,
      output: summary.output,
      mode: summary.mode,
      videoCodec: summary.videoCodec,
      audioCodec: summary.audioCodec,
      label,
    });
  }
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
  if (child.stdout === null || child.stderr === null) throw new Error(`${label}: 子进程管道不可用`);

  let stdout = "";
  let stderr = "";
  // ffmpeg 用 \r 刷新进度行：按 \r 与 \n 切行，逐行回调（转码进度解析 time=）
  let pendingLine = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (opts.onStderrLine === undefined) return;
    pendingLine += chunk;
    let at = pendingLine.search(/[\r\n]/);
    while (at !== -1) {
      const line = pendingLine.slice(0, at);
      pendingLine = pendingLine.slice(at + 1);
      if (line !== "") opts.onStderrLine(line);
      at = pendingLine.search(/[\r\n]/);
    }
  });

  activeChildren.add(child);
  const code = await new Promise<number>((resolveCode, rejectCode) => {
    child.once("error", (err) => {
      activeChildren.delete(child);
      rejectCode(new Error(`${label} 启动失败: ${(err as NodeJS.ErrnoException).code === "ENOENT" ? `命令不存在: ${file}` : err.message}`));
    });
    child.once("close", (exitCode) => {
      activeChildren.delete(child);
      resolveCode(exitCode ?? 1);
    });
  });
  // Windows 子进程管道输出 CRLF；统一成 LF，下游解析（tar 清单、ffprobe JSON、silencedetect）只看到 LF
  stdout = stdout.replace(/\r\n/g, "\n");
  stderr = stderr.replace(/\r\n/g, "\n");

  const durationMs = Date.now() - startedAt;
  if (code !== 0) {
    // 日志保留 50 行尾部，抛错消息保持 12 行不变
    const tail50 = stderr
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(-50)
      .join("\n");
    log.error(mod, "命令失败", { code, durationMs, stderrTail: tail50 });
  } else {
    log.info(mod, "命令完成", { code, durationMs });
  }

  if (code !== 0 && !opts.allowFail) {
    const tail = stderr.trim().split("\n").slice(-12).join("\n");
    throw new Error(`${label} failed (exit ${code})\n${tail}`);
  }
  return { stdout, stderr, code };
}
