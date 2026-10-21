import { openSync, readFileSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { CACHE_DIRNAME } from "./config";

export type VideoLock = { release(): void };

export const RUN_LOCK_FILE = ".vnote-run.lock";

type LockContent = { pid: number; startedAt: number; token: string };

const MAX_ACQUIRE_ATTEMPTS = 5;

function lockPath(outputDir: string): string {
  return resolve(outputDir, RUN_LOCK_FILE);
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
    return { pid: parsed.pid, startedAt: parsed.startedAt, token: typeof parsed.token === "string" ? parsed.token : "" };
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
 * 同一视频同时只允许一个运行（ADR-0011）。锁文件 `.vnote-run.lock` 记 `{pid, startedAt, token}`：
 * 创建用 `wx` 独占，原子；活进程一律抢占失败，运行超过 24h 也不抢占，pid 复用作为已知限制接受。
 * 陈旧锁（持有者 ESRCH）或内容损坏的锁，用 `rename` 挪到 `.stale.<pid>.<rand>` 再独占创建；
 * rename 的 ENOENT 说明别的进程已抢先接管，重试（最多 5 次），避免 rmSync 式无条件删除导致的双接管。
 * 释放只在文件里的 token 与本次持有 token 一致时删除，外部改写过的文件不删。
 */
export function acquireVideoLock(outputDir: string): VideoLock {
  const path = lockPath(outputDir);
  const token = randomUUID();
  for (let attempt = 0; ; attempt++) {
    const existing = readLock(path);
    if (existing !== undefined && processAlive(existing.pid)) {
      throw new Error(`视频正在运行（pid ${existing.pid}）`);
    }
    try {
      openSync(path, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const staleName = `${path}.stale.${existing?.pid ?? "unknown"}.${Math.random().toString(36).slice(2)}`;
      try {
        renameSync(path, staleName);
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code !== "ENOENT") throw e2;
      }
      if (attempt + 1 >= MAX_ACQUIRE_ATTEMPTS) throw err;
      continue;
    }
    // wx 已保证创建者唯一；写失败时锁文件存在但内容空，持有者下次按陈旧处理
    try {
      writeFileSync(path, `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), token }, null, 2)}\n`);
    } catch {
      // 保留锁本身，内容留给下次接管时覆盖
    }
    const release = (): void => {
      try {
        const current = readLock(path);
        if (current !== undefined && current.token === token) rmSync(path);
      } catch {
        // 重复 release 或文件已消失：静默
      }
    };
    return { release };
  }
}

/** 是否还有活进程持有该视频的锁：先查新路径，再查旧路径（旧路径的锁是变更前启动的运行留下的，同样的 pid 探测）。 */
export function isVideoLocked(outputDir: string): boolean {
  const fresh = readLock(lockPath(outputDir));
  if (fresh !== undefined && processAlive(fresh.pid)) return true;
  const legacy = readLock(resolve(outputDir, CACHE_DIRNAME, "run.lock"));
  return legacy !== undefined && processAlive(legacy.pid);
}
/** 活进程是否持有该视频的锁，且不是本进程：本进程自己持有的锁不算「正在生成」（流水线持有锁期间要写进度），缺失/损坏/死 pid 的锁视为无锁。 */
export function isVideoLockHeldByForeign(outputDir: string): boolean {
  const fresh = readLock(lockPath(outputDir));
  if (fresh !== undefined && processAlive(fresh.pid) && fresh.pid !== process.pid) return true;
  const legacy = readLock(resolve(outputDir, CACHE_DIRNAME, "run.lock"));
  return legacy !== undefined && processAlive(legacy.pid) && legacy.pid !== process.pid;
}
