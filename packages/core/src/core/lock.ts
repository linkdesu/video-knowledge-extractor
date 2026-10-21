import { openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CACHE_DIRNAME } from "./config";
import { ensureDir } from "./paths";

export type VideoLock = { release(): void };

type LockContent = { pid: number; startedAt: number };

function lockPath(outputDir: string): string {
  return resolve(outputDir, CACHE_DIRNAME, "run.lock");
}

function readLock(path: string): LockContent | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockContent>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "number") return undefined;
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return undefined;
  }
}

/** `process.kill(pid, 0)`：ESRCH 才证明进程不存在；EPERM 说明进程存在只是权限不足。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * 同一视频同时只允许一个运行（ADR-0011）。锁文件 `.cache/run.lock` 记 `{pid, startedAt}`：
 * 持有者进程不存在（ESRCH）才视为陈旧并接管，活进程一律抢占失败——
 * 运行超过 24h 也不抢占，pid 复用（旧 pid 被新进程占用）作为已知限制接受，不引入额外机制。
 * 创建用 O_EXCL 保证原子性，避免 check-then-write 竞态下的双重接管。
 */
export function acquireVideoLock(outputDir: string): VideoLock {
  const path = lockPath(outputDir);
  ensureDir(resolve(outputDir, CACHE_DIRNAME));
  const existing = readLock(path);
  if (existing !== undefined && processAlive(existing.pid)) {
    throw new Error(`视频正在运行（pid ${existing.pid}）`);
  }
  // 锁不存在或持有者已死（ESRCH）：清掉残留文件后独占创建
  rmSync(path, { force: true });
  try {
    openSync(path, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // 清残留与创建之间的窗口里可能有别的进程先落锁，以最新内容为准
      const current = readLock(path);
      throw new Error(`视频正在运行（pid ${current?.pid ?? "?"}）`);
    }
    throw err;
  }
  // wx 已保证创建者唯一；写失败时锁文件存在但内容空，持有者下次按陈旧处理
  try {
    writeFileSync(path, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() }, null, 2)}\n`);
  } catch {
    // 保留锁本身，内容留给下次接管时覆盖
  }
  const release = (): void => {
    try {
      const current = readLock(path);
      if (current !== undefined && current.pid === process.pid) rmSync(path);
    } catch {
      // 重复 release 或文件已消失：静默
    }
  };
  return { release };
}
