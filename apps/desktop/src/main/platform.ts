import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * 平台差异收敛（r34）：PATH 补工具目录、进程树杀法、默认数据根。
 * 每个函数都接受可注入的 platform/env/spawn，让主进程测试在任意宿主上断言行为。
 */
export type ToolDirOptions = { platform?: NodeJS.Platform; resourcesPath?: string; env?: NodeJS.ProcessEnv };

/**
 * 按平台列出要补到 PATH 前面的工具目录：
 * - win32：VNOTE_FFMPEG_DIR（若设置）+ 打包版随 app 带的 ffmpeg（<resourcesPath>/ffmpeg）；没有 Homebrew 与 /usr/bin 之类的 unix 路径。
 * - posix：保持原顺序 VNOTE_FFMPEG_DIR、/opt/homebrew/bin、/usr/local/bin、/usr/bin、/bin。
 */
export function toolDirs(opts?: ToolDirOptions): string[] {
  const platform = opts?.platform ?? process.platform;
  const env = opts?.env ?? process.env;
  const ffmpegDir = env.VNOTE_FFMPEG_DIR;
  const dirs: string[] = [];
  if (ffmpegDir !== undefined && ffmpegDir !== "") dirs.push(ffmpegDir);
  if (platform === "win32") {
    // 打包版把 ffmpeg 打进 resources；未打包（dev）没有 resources，只认 VNOTE_FFMPEG_DIR
    const resourcesPath = opts?.resourcesPath;
    if (resourcesPath !== undefined && resourcesPath !== "") dirs.push(join(resourcesPath, "ffmpeg"));
    return dirs;
  }
  dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");
  return dirs;
}
/** 工具目录 + 现有 PATH 拼成新的 PATH：空项过滤、重复项去重（保留首次出现）；分隔符按平台（win32 用 ;）。 */
export function prependPath(opts?: ToolDirOptions & { currentPath?: string }): string {
  const platform = opts?.platform ?? process.platform;
  const delim = platform === "win32" ? ";" : ":";
  const current = opts?.currentPath ?? opts?.env?.PATH ?? process.env.PATH ?? "";
  const parts = [...toolDirs(opts), ...current.split(delim)].filter((p) => p !== "");
  const seen = new Set<string>();
  return parts.filter((p) => (seen.has(p) ? false : (seen.add(p), true))).join(delim);
}

/**
 * 杀整个进程树：
 * - win32：`taskkill /PID <pid> /T /F`（/T 连带子进程），非零退出码（进程已死）忽略。
 * - posix：`pgrep -P <pid>` 找到 worker spawn 的 ffmpeg/ffprobe 补杀一层，再 SIGKILL worker 本身；ESRCH 忽略。
 */
export function killProcessTree(
  pid: number,
  opts?: { platform?: NodeJS.Platform; spawn?: (cmd: string, args: string[]) => { status: number | null; stdout: string } },
): void {
  const platform = opts?.platform ?? process.platform;
  const spawn =
    opts?.spawn ??
    ((cmd: string, args: string[]) => {
      const out = spawnSync(cmd, args);
      return { status: out.status, stdout: out.stdout.toString() };
    });
  if (platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  const out = spawn("pgrep", ["-P", String(pid)]);
  if (out.status === 0) {
    for (const line of out.stdout.split("\n")) {
      const childPid = Number(line);
      if (!Number.isInteger(childPid) || childPid <= 0) continue;
      try {
        process.kill(childPid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") console.warn(err);
      }
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") console.warn(err);
  }
}

/** 默认数据根：<Documents>/video-notes，所有平台一致（core 的 dataRoot 兜底同形）。 */
export function defaultDataRoot(documentsPath: string): string {
  return join(documentsPath, "video-notes");
}
