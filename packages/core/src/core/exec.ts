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

/**
 * Bun.spawn 的最小结构。故意不写 `Bun` 全局命名空间：core 也被 desktop 的 renderer
 * tsconfig（只有 DOM lib、没有 bun types）拉进来编译，引用 Bun 命名空间会让那边 typecheck 红。
 */
type BunByteReader = {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    releaseLock?(): void;
  };
};

type BunChild = {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly exited: Promise<number>;
  readonly stdout: BunByteReader;
  readonly stderr: BunByteReader;
  kill(signal?: string): void;
};

type BunRuntime = {
  spawn(cmd: string[], options: { stdin: "ignore"; stdout: "pipe"; stderr: "pipe" }): BunChild;
};

/**
 * Bun 运行时（CLI / bun test）有 `Bun.spawn`；Electron 主进程没有。
 * core 也被 desktop 的 renderer tsconfig（DOM lib、无 bun types）编译，不能写 `Bun` 命名空间，
 * 所以从 globalThis 上按结构类型取（Reflect.get 返回 any，这是唯一一次断言，只取 spawn）。
 */
const bunRuntime = Reflect.get(globalThis, "Bun") as BunRuntime | undefined;

// Bun 路径的子进程（取消时同样要杀）
const activeBunChildren = new Set<BunChild>();

/** 杀掉所有尚未结束的子进程（SIGKILL）；用于取消提取。 */
export function killActiveChildren(): void {
  for (const child of [...activeChildren]) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } catch {
      // 已退出的进程 kill 会抛 ESRCH，忽略
    }
  }
  for (const proc of [...activeBunChildren]) {
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch {
      // 已退出的进程 kill 会抛 ESRCH，忽略
    }
  }
}

/** ffmpeg 用 \r 刷新进度行：按 \r 与 \n 切行，逐行回调（转码进度解析 time=）。 */
function stderrLineSplitter(onLine: ((line: string) => void) | undefined): (chunk: string) => void {
  let pending = "";
  return (chunk) => {
    if (onLine === undefined) return;
    pending += chunk;
    let at = pending.search(/[\r\n]/);
    while (at !== -1) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (line !== "") onLine(line);
      at = pending.search(/[\r\n]/);
    }
  };
}

/** 读完一条管道并解码成 UTF-8；每块原文交给 onChunk（stderr 的逐行回调用）。 */
async function readUtf8(stream: BunByteReader, onChunk?: (chunk: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    const chunk = decoder.decode(value, { stream: true });
    text += chunk;
    onChunk?.(chunk);
  }
  const tail = decoder.decode();
  text += tail;
  onChunk?.(tail);
  return text;
}

/** Node/Electron 路径：node:child_process，收齐两条管道后按 close 收尾。 */
async function spawnWithNode(
  file: string,
  args: string[],
  opts: {
    label: string;
    onStderrLine?: (line: string) => void;
    logSpawnFailure: (reason: string) => void;
  },
): Promise<ProcResult> {
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
  if (child.stdout === null || child.stderr === null) {
    // 进程能建但管道没建成（资源耗尽的一种形态）：同样要落日志，否则诊断里只剩一句「启动失败」
    opts.logSpawnFailure("子进程管道不可用");
    throw new Error(`${opts.label}: 子进程管道不可用`);
  }

  let stdout = "";
  let stderr = "";
  const splitStderr = stderrLineSplitter(opts.onStderrLine);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    splitStderr(chunk);
  });

  activeChildren.add(child);
  const code = await new Promise<number>((resolveCode, rejectCode) => {
    child.once("error", (err) => {
      activeChildren.delete(child);
      // spawn 失败（ENOENT / EAGAIN 等）以前只 reject 不写日志：诊断里看不出「起不来」，
      // 只有一声没有上下文的启动失败（r62 / #79）。这里补一条 ERROR，带上命令与 errno。
      const errno = (err as NodeJS.ErrnoException).code ?? "unknown";
      opts.logSpawnFailure(`${errno} ${err.message}`);
      rejectCode(new Error(`${opts.label} 启动失败: ${errno === "ENOENT" ? `命令不存在: ${file}` : err.message}`));
    });
    child.once("close", (exitCode) => {
      activeChildren.delete(child);
      resolveCode(exitCode ?? 1);
    });
  });
  return { stdout, stderr, code };
}

/**
 * Bun 路径：Bun.spawn。
 *
 * bun 的 `node:child_process` 实现在 macOS 高负载下会在 `spawn()` 栈内就把 `exit`/`close`
 * 发掉（oven-sh/bun#45483：kqueue 的 `EVFILT_PROC` 注册在 fork 后约 1 ms 才做，短命子进程
 * 已被 reap，`ReportUnwatchedExit` 在 `Bun.spawn()` 返回前跑完 onExit），两条管道的数据也
 * 已被消费。之后附着的监听器永远收不到，`run()` 就永远不 settle —— #92 的 30 s 超时。
 * `Bun.spawn` 没有这条路径（上游对照 0/300），且 `exited` 是 promise：即使进程在 spawn
 * 期间已退出，它也已经 resolved，管道数据仍可读。
 */
async function spawnWithBun(
  cmd: string[],
  opts: {
    label: string;
    onStderrLine?: (line: string) => void;
    logSpawnFailure: (reason: string) => void;
  },
): Promise<ProcResult> {
  const runtime = bunRuntime;
  if (runtime === undefined) throw new Error("Bun 运行时不可用");
  let proc: BunChild;
  try {
    proc = runtime.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code ?? "unknown";
    opts.logSpawnFailure(`${errno} ${(err as Error).message}`);
    throw new Error(`${opts.label} 启动失败: ${errno === "ENOENT" ? `命令不存在: ${cmd[0]}` : (err as Error).message}`);
  }
  activeBunChildren.add(proc);
  try {
    const splitStderr = stderrLineSplitter(opts.onStderrLine);
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      readUtf8(proc.stdout),
      readUtf8(proc.stderr, splitStderr),
    ]);
    return { stdout, stderr, code };
  } finally {
    activeBunChildren.delete(proc);
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
  const logSpawnFailure = (reason: string) => {
    log.error(mod, "命令启动失败", { cmd: file, reason, label, durationMs: Date.now() - startedAt });
  };
  const spawnOpts = { label, onStderrLine: opts.onStderrLine, logSpawnFailure };
  // CLI 跑在 bun 下；Electron 主进程是 Node。两条路径只差「怎么起进程」，
  // 后面的 CRLF 归一、日志与错误格式完全共用。
  const result =
    bunRuntime === undefined ? await spawnWithNode(file, args, spawnOpts) : await spawnWithBun(cmd, spawnOpts);
  let stdout = result.stdout;
  let stderr = result.stderr;
  const code = result.code;
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
