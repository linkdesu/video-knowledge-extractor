import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_DIRNAME } from "./config";
import { acquireVideoLock, isVideoLocked, RUN_LOCK_FILE } from "./lock";

// int32 上限的 pid 在任何平台都不存在（kill(pid, 0) → ESRCH）
const DEAD_PID = 2147483647;

function fixtureDir(): string {
  const dir = join(tmpdir(), "vnote-lock-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function newLockPath(dir: string): string {
  return join(dir, RUN_LOCK_FILE);
}

function legacyLockPath(dir: string): string {
  return join(dir, CACHE_DIRNAME, "run.lock");
}

function writeStaleLock(dir: string, pid: number): void {
  mkdirSync(join(dir, CACHE_DIRNAME), { recursive: true });
  writeFileSync(legacyLockPath(dir), `${JSON.stringify({ pid, startedAt: Date.now() })}\n`);
}

function readLockJson(path: string): { pid: number; startedAt?: number; token?: string } {
  return JSON.parse(readFileSync(path, "utf8")) as { pid: number; startedAt?: number; token?: string };
}

describe("acquireVideoLock", () => {
  test("本进程持锁后再次获取抛「视频正在运行（pid N）」，release 后文件消失", () => {
    const dir = fixtureDir();
    const lock = acquireVideoLock(dir);
    expect(() => acquireVideoLock(dir)).toThrow(`视频正在运行（pid ${process.pid}）`);
    lock.release();
    expect(existsSync(newLockPath(dir))).toBe(false);
  });

  test("两次并发获取不会都成功：第一个拿到锁，第二个抛（同进程内用外部写入模拟竞争）", () => {
    const dir = fixtureDir();
    const lock = acquireVideoLock(dir);
    const content = readLockJson(newLockPath(dir));
    expect(content.pid).toBe(process.pid);
    expect(typeof content.token).toBe("string");
    expect(() => acquireVideoLock(dir)).toThrow("视频正在运行");
    lock.release();
  });

  test("陈旧锁（进程不存在）可接管：新锁内容是新 pid 与 token，rename 出的 .stale 残骸被清掉", () => {
    const dir = fixtureDir();
    writeStaleLock(dir, DEAD_PID);
    const lock = acquireVideoLock(dir);
    const content = readLockJson(newLockPath(dir));
    expect(content.pid).toBe(process.pid);
    expect(typeof content.token).toBe("string");
    expect(readdirSync(dir).filter((n) => n.startsWith(`${RUN_LOCK_FILE}.stale.`))).toEqual([]);
    lock.release();
    expect(existsSync(newLockPath(dir))).toBe(false);
  });

  test("取锁后锁文件立即是完整 JSON（直接写 fd 并关闭句柄），release 后再次取锁成功", () => {
    const dir = fixtureDir();
    const first = acquireVideoLock(dir);
    const content = readLockJson(newLockPath(dir));
    expect(content.pid).toBe(process.pid);
    expect(typeof content.startedAt).toBe("number");
    expect(typeof content.token).toBe("string");
    expect(content.token).not.toBe("");
    first.release();
    // 模拟 extract 结束后紧接着跑 notes：锁必须已释放，第二次取锁 100% 成功
    const second = acquireVideoLock(dir);
    expect(readLockJson(newLockPath(dir)).pid).toBe(process.pid);
    second.release();
    expect(existsSync(newLockPath(dir))).toBe(false);
  });

  test("空锁文件（Windows 上写到一半/句柄未关的残留）可接管", () => {
    const dir = fixtureDir();
    writeFileSync(newLockPath(dir), "");
    const lock = acquireVideoLock(dir);
    expect(readLockJson(newLockPath(dir)).pid).toBe(process.pid);
    lock.release();
    expect(existsSync(newLockPath(dir))).toBe(false);
  });

  test("历史 .stale 残骸在取锁与释放时都被清掉", () => {
    const dir = fixtureDir();
    const leftover = `${newLockPath(dir)}.stale.${DEAD_PID}.abcdef`;
    writeFileSync(leftover, "old");
    const lock = acquireVideoLock(dir);
    expect(existsSync(leftover)).toBe(false);
    const another = `${newLockPath(dir)}.stale.${DEAD_PID}.ghijkl`;
    writeFileSync(another, "old");
    lock.release();
    expect(existsSync(another)).toBe(false);
  });

  test("内容损坏的锁文件可接管", () => {
    const dir = fixtureDir();
    writeFileSync(newLockPath(dir), "not json\n");
    const lock = acquireVideoLock(dir);
    lock.release();
    expect(existsSync(newLockPath(dir))).toBe(false);
  });

  test("release 重复调用不抛", () => {
    const dir = fixtureDir();
    const lock = acquireVideoLock(dir);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  test("锁文件被外部换成别的 token 后 release 不删（只删自己 token 的）", () => {
    const dir = fixtureDir();
    const lock = acquireVideoLock(dir);
    const first = readLockJson(newLockPath(dir));
    writeFileSync(newLockPath(dir), `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: "foreign-token" })}\n`);
    lock.release();
    expect(existsSync(newLockPath(dir))).toBe(true);
    const still = readLockJson(newLockPath(dir));
    expect(still.token).toBe("foreign-token");
    expect(first.token).not.toBe("foreign-token");
  });
});

describe("isVideoLocked", () => {
  test("识别新路径的存活锁", () => {
    const dir = fixtureDir();
    const lock = acquireVideoLock(dir);
    expect(isVideoLocked(dir)).toBe(true);
    lock.release();
    expect(isVideoLocked(dir)).toBe(false);
  });

  test("识别旧路径（.cache/run.lock）的存活锁，防止变更前启动的视频被误判空闲", () => {
    const dir = fixtureDir();
    mkdirSync(join(dir, CACHE_DIRNAME), { recursive: true });
    writeFileSync(legacyLockPath(dir), `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
    expect(isVideoLocked(dir)).toBe(true);
  });

  test("两条路径都是陈旧锁（死 pid）时不误报锁定", () => {
    const dir = fixtureDir();
    writeFileSync(newLockPath(dir), `${JSON.stringify({ pid: DEAD_PID, startedAt: Date.now(), token: "x" })}\n`);
    writeStaleLock(dir, DEAD_PID);
    expect(isVideoLocked(dir)).toBe(false);
  });
});
