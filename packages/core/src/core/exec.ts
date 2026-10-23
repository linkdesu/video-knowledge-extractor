import { spawn, type ChildProcess } from "node:child_process";
import { logger, type LogModule } from "./logger";

/**
 * 子进程执行：收 stdout/stderr；非零退出默认抛错。
 */
export type ProcResult = { stdout: string; stderr: string; code: number };

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
  opts: { label?: string; allowFail?: boolean; logModule?: LogModule } = {},
): Promise<ProcResult> {
  const [file, ...args] = cmd;
  if (file === undefined) throw new Error("run 至少需要一个命令");
  const label = opts.label ?? file;
  const mod = opts.logModule ?? "ffmpeg";
  const log = logger();
  const startedAt = Date.now();
  // 整条 argv 一次性记录，URL 内嵌的 key 也能被 redact 命中
  log.info(mod, file, { cmd });
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
  if (child.stdout === null || child.stderr === null) throw new Error(`${label}: 子进程管道不可用`);

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
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
