import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { modelLockPath } from "./catalog";

export type ModelLock = { release(): void };

type ModelLockContent = { pid: number; createdAt: number; token: string };

/**
 * 模型目录互斥锁（ADR-0015 §4）：`<modelDir>/.vnote-models.lock` 用 wx 独占创建，
 * 内容 `{pid, createdAt, token}`。
 * 锁已存在且 pid 存活 → 拒绝（「模型正在被另一个操作使用」）；
 * pid 已死 → 只 unlink 后重试一次。绝不 rename 活锁：先读后 rename 有把
 * 别人新建的锁搬走的竞态（与视频锁不同的实现，不复制它的接管方式）。
 */
export function acquireModelLock(modelDirArg: string): ModelLock {
  const path = modelLockPath(resolve(modelDirArg));
  const token = randomUUID();
  for (let attempt = 0; ; attempt++) {
    const existing = readLock(path);
    if (existing !== undefined && processAlive(existing.pid)) {
      throw new Error("模型正在被另一个操作使用");
    }
    try {
      const handle = openSync(path, "wx");
      closeSync(handle);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // 锁存在但读到时 pid 已死：删除后重试一次
      if (attempt + 1 >= 2) throw new Error("模型正在被另一个操作使用");
      try {
        rmSync(path);
      } catch {
        // 别的进程已先删除：直接重试创建
      }
      continue;
    }
    try {
      writeFileSync(path, `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }, null, 2)}\n`);
    } catch {
      // 写失败时锁文件存在但内容空，持有者下次按陈旧处理
    }
    const released = { done: false };
    return {
      release(): void {
        if (released.done) return;
        released.done = true;
        try {
          const current = readLock(path);
          if (current !== undefined && current.token === token) rmSync(path);
        } catch {
          // 重复 release 或文件已消失：静默
        }
      },
    };
  }
}

function readLock(path: string): ModelLockContent | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ModelLockContent>;
    if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "number") return undefined;
    return { pid: parsed.pid, createdAt: parsed.createdAt, token: typeof parsed.token === "string" ? parsed.token : "" };
  } catch {
    return undefined;
  }
}

// process.kill(pid, 0)：ESRCH 才证明进程不存在；EPERM 说明进程存在只是权限不足
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
