import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_DIRNAME } from "./config";
import { acquireVideoLock } from "./lock";

function fixtureDir(): string {
  const dir = join(tmpdir(), "vnote-lock-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(join(dir, CACHE_DIRNAME), { recursive: true });
  return dir;
}

function writeStaleLock(dir: string, pid: number): void {
  mkdirSync(join(dir, CACHE_DIRNAME), { recursive: true });
  writeFileSync(join(dir, CACHE_DIRNAME, "run.lock"), `${JSON.stringify({ pid, startedAt: Date.now() })}\n`);
}

// int32 上限的 pid 在任何平台都不存在（kill(pid, 0) → ESRCH）
const DEAD_PID = 2147483647;

describe("acquireVideoLock", () => {
  test("本进程持锁后再次获取抛「视频正在运行」，release 后文件消失", () => {
    const dir = fixtureDir();
    const lock = acquireVideoLock(dir);
    expect(() => acquireVideoLock(dir)).toThrow("视频正在运行");
    lock.release();
    expect(existsSync(join(dir, CACHE_DIRNAME, "run.lock"))).toBe(false);
  });

  test("陈旧锁（进程不存在）可接管，锁文件内容更新为新 pid", () => {
    const dir = fixtureDir();
    writeStaleLock(dir, DEAD_PID);
    const lock = acquireVideoLock(dir);
    const content = JSON.parse(readFileSync(join(dir, CACHE_DIRNAME, "run.lock"), "utf8")) as { pid: number };
    expect(content.pid).toBe(process.pid);
    lock.release();
    expect(existsSync(join(dir, CACHE_DIRNAME, "run.lock"))).toBe(false);
  });

  test("损坏的锁文件内容可接管", () => {
    const dir = fixtureDir();
    writeFileSync(join(dir, CACHE_DIRNAME, "run.lock"), "not json\n");
    const lock = acquireVideoLock(dir);
    lock.release();
    expect(existsSync(join(dir, CACHE_DIRNAME, "run.lock"))).toBe(false);
  });

  test("release 重复调用不抛", () => {
    const dir = fixtureDir();
    const lock = acquireVideoLock(dir);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  test("锁文件被外部换成别的 pid 后 release 不删（只删自己持有的）", () => {
    const dir = fixtureDir();
    const lock = acquireVideoLock(dir);
    writeStaleLock(dir, DEAD_PID);
    lock.release();
    expect(existsSync(join(dir, CACHE_DIRNAME, "run.lock"))).toBe(true);
    rmSync(join(dir, CACHE_DIRNAME, "run.lock"), { force: true });
  });
});
