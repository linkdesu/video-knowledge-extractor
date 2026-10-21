import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_LOCK_FILE } from "./catalog";
import { acquireModelLock } from "./oplock";

// int32 上限的 pid 在任何平台都不存在（kill(pid, 0) → ESRCH）
const DEAD_PID = 2147483647;

function tempModelDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vnote-models-lock-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function lockPath(dir: string): string {
  return join(dir, MODEL_LOCK_FILE);
}

describe("acquireModelLock", () => {
  test("空目录取锁成功，release 后文件消失，重复 release 不抛", () => {
    const dir = tempModelDir();
    const lock = acquireModelLock(dir);
    expect(existsSync(lockPath(dir))).toBe(true);
    const content = JSON.parse(readFileSync(lockPath(dir), "utf8")) as { pid: number; token: string };
    expect(content.pid).toBe(process.pid);
    lock.release();
    expect(existsSync(lockPath(dir))).toBe(false);
    lock.release();
    rmSync(dir, { recursive: true });
  });

  test("活 pid 锁拒绝：错误文案「模型正在被另一个操作使用」，锁文件内容不动", () => {
    const dir = tempModelDir();
    writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "other" }));
    expect(() => acquireModelLock(dir)).toThrow("模型正在被另一个操作使用");
    expect(JSON.parse(readFileSync(lockPath(dir), "utf8")).token).toBe("other");
    rmSync(dir, { recursive: true });
  });

  test("死 pid 锁：unlink 后重试一次成功", () => {
    const dir = tempModelDir();
    writeFileSync(lockPath(dir), JSON.stringify({ pid: DEAD_PID, createdAt: Date.now(), token: "dead" }));
    const lock = acquireModelLock(dir);
    const content = JSON.parse(readFileSync(lockPath(dir), "utf8")) as { pid: number };
    expect(content.pid).toBe(process.pid);
    lock.release();
    rmSync(dir, { recursive: true });
  });

  test("内容损坏的锁文件：按死锁清理后成功", () => {
    const dir = tempModelDir();
    writeFileSync(lockPath(dir), "{not json");
    const lock = acquireModelLock(dir);
    lock.release();
    expect(existsSync(lockPath(dir))).toBe(false);
    rmSync(dir, { recursive: true });
  });

  test("release 只删自己 token 的锁：外部改写后不删", () => {
    const dir = tempModelDir();
    const lock = acquireModelLock(dir);
    writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "replaced" }));
    lock.release();
    expect(existsSync(lockPath(dir))).toBe(true);
    rmSync(dir, { recursive: true });
  });

  test("锁文件被外部删除后 release 不抛", () => {
    const dir = tempModelDir();
    const lock = acquireModelLock(dir);
    rmSync(lockPath(dir));
    expect(() => lock.release()).not.toThrow();
    rmSync(dir, { recursive: true });
  });
});
