import { closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { CACHE_DIRNAME } from "./config";
import { logger } from "./logger";

export type VideoLock = { release(): void };

export const RUN_LOCK_FILE = ".vnote-run.lock";

type LockContent = { pid: number; startedAt: number; token: string };

const MAX_ACQUIRE_ATTEMPTS = 5;
const STALE_PREFIX = `${RUN_LOCK_FILE}.stale.`;

function lockPath(outputDir: string): string {
  return resolve(outputDir, RUN_LOCK_FILE);
}

function errnoCode(err: unknown): string | null {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : null;
}

/** Windows 上句柄释放有几十毫秒延迟：同步小步重试，Electron/Node 与 Bun 都可用。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 删除单个文件；`EPERM`/`EACCES`/`EBUSY`（Windows 句柄未释放、只读位）时短重试。 */
function unlinkWithRetry(path: string, attempts = 5, delayMs = 50): void {
  for (let i = 0; ; i++) {
    try {
      rmSync(path, { force: true });
      return;
    } catch (err) {
      const code = errnoCode(err);
      if (i + 1 >= attempts || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw err;
      sleepSync(delayMs);
    }
  }
}

/** 清掉接管陈旧锁时 rename 出来的 `.vnote-run.lock.stale.*` 残骸（Windows 上 rename 失败会退化为直接删除）。 */
function removeStaleLocks(path: string): void {
  const dir = dirname(path);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(STALE_PREFIX)) continue;
    try {
      unlinkWithRetry(resolve(dir, name), 2, 10);
    } catch {
      // 仍被占用：留到下轮 acquire/release 再清
    }
  }
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
 * Windows 上已存在的锁文件可能报 `EPERM`/`EACCES`（只读/隐藏/共享冲突）而不是 `EEXIST`：
 * 同样按「已占用」处理，且 rename 失败时退化为带重试的直接删除。
 * 内容通过 `openSync` 返回的 fd 写入后立刻 `closeSync`：不关闭句柄时 Windows 会自锁写入、
 * 并且释放锁时删不掉文件（r40 的 `.vnote-run.lock` 残留根因）。
 * 释放只在文件里的 token 与本次持有 token 一致时删除，外部改写过的文件不删；随后清掉 `.stale` 残骸。
 */
export function acquireVideoLock(outputDir: string): VideoLock {
  const path = lockPath(outputDir);
  const token = randomUUID();
  removeStaleLocks(path);
  for (let attempt = 0; ; attempt++) {
    const existing = readLock(path);
    if (existing !== undefined && processAlive(existing.pid)) {
      throw new Error(`视频正在运行（pid ${existing.pid}）`);
    }
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (err) {
      const code = errnoCode(err);
      const message = err instanceof Error ? err.message : String(err);
      // Windows 已存在的锁文件（只读/隐藏/共享冲突）可能报 EPERM/EACCES 而非 EEXIST
      const occupied = code === "EEXIST" || ((code === "EPERM" || code === "EACCES") && existsSync(path));
      if (!occupied) {
        logger().error("fs", "获取运行锁失败", { path, code, message });
        throw err;
      }
      // 抢占前重读：别的进程可能刚建了活锁
      const stale = readLock(path);
      if (stale !== undefined && processAlive(stale.pid)) {
        const busy = `视频正在运行（pid ${stale.pid}）`;
        logger().error("fs", "获取运行锁失败", { path, code, message: busy });
        throw new Error(busy);
      }
      logger().info("fs", "清理陈旧运行锁", { path, stalePid: stale?.pid ?? null });
      const staleName = `${path}.stale.${stale?.pid ?? "unknown"}.${Math.random().toString(36).slice(2)}`;
      try {
        renameSync(path, staleName);
      } catch (e2) {
        const code2 = errnoCode(e2);
        if (code2 !== "ENOENT") {
          if (code2 === "EPERM" || code2 === "EACCES" || code2 === "EBUSY") {
            // Windows 上只读/隐藏的残留锁 rename 会失败：直接删掉再重试
            try {
              unlinkWithRetry(path, 3, 50);
            } catch (e3) {
              const finalCode = errnoCode(e3);
              logger().error("fs", "获取运行锁失败", {
                path,
                code: finalCode,
                message: e3 instanceof Error ? e3.message : String(e3),
              });
              throw e3;
            }
          } else {
            throw e2;
          }
        }
      }
      if (attempt + 1 >= MAX_ACQUIRE_ATTEMPTS) {
        logger().error("fs", "获取运行锁失败", { path, code, message, attempts: attempt + 1 });
        throw err;
      }
      continue;
    }
    // wx 已保证创建者唯一；直接写 fd 再关闭，Windows 上不会出现句柄泄漏导致的写入失败与删不掉
    try {
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), token }, null, 2)}\n`);
    } catch (err) {
      logger().error("fs", "写入运行锁失败", {
        path,
        code: errnoCode(err),
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败没有补救手段
      }
    }
    removeStaleLocks(path);
    const release = (): void => {
      try {
        const current = readLock(path);
        if (current !== undefined && current.token === token) unlinkWithRetry(path);
      } catch {
        // 重复 release 或文件已消失：静默
      }
      removeStaleLocks(path);
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
