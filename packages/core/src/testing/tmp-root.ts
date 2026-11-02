import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "bun:test";

/**
 * 测试进程的 TMPDIR 隔离（#101）。
 *
 * 每个 `bun test` 进程独占 `<repo>/tmp/test-<pid>`，preload 里调用
 * `installIsolatedTmpDir(repoRoot)` 后，`os.tmpdir()` 及其下游的
 * `mkdtempSync(tmpdir(), …)` 全部落在仓库内，不再堆进系统 `$TMPDIR`
 * （历史事故：53 个测试文件 119 处 mkdtemp 从不删除，一度占用 109.6 GB）。
 *
 * `bun test` 不会触发 `process.on("exit")`（实测 1.4.0），所以清理挂在
 * preload 作用域的 `afterAll` 上——它只在整轮测试跑完后执行一次。
 * 进程被 kill / 崩溃时清理不到，由下一次 preload 的 `pruneStaleTestTmpDirs`
 * 兜住（死 pid 与超龄目录）。
 */

/** 进程被 kill 后留下的目录，超过这个年龄即使 pid 被复用也视为残留。 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const RUN_DIR_NAME = /^test-(\d+)$/;

export interface PruneOptions {
  /** 判定 pid 是否存活；测试注入用。 */
  isAlive?: (pid: number) => boolean;
  maxAgeMs?: number;
}

/** 本进程独占的测试临时目录：`<repo>/tmp/test-<pid>`。 */
export function testTmpRunDir(repoRoot: string): string {
  return join(repoRoot, "tmp", `test-${process.pid}`);
}

/**
 * 清掉 `<repo>/tmp` 下已死进程的 `test-<pid>` 目录。
 * 并发跑测试时活进程的目录一律保留；pid 被复用时靠 mtime 超龄兜底。
 * 返回被删掉的目录（绝对路径）。
 */
export function pruneStaleTestTmpDirs(tmpParent: string, options: PruneOptions = {}): string[] {
  const isAlive = options.isAlive ?? pidAlive;
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
  const now = Date.now();

  let names: string[];
  try {
    names = readdirSync(tmpParent);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const name of names) {
    const match = RUN_DIR_NAME.exec(name);
    if (match === null) continue;
    const dir = join(tmpParent, name);
    let stale = !isAlive(Number(match[1]));
    if (!stale) {
      try {
        stale = now - statSync(dir).mtimeMs > maxAgeMs;
      } catch {
        stale = false;
      }
    }
    if (!stale) continue;
    removeQuietly(dir);
    removed.push(dir);
  }
  return removed;
}

/**
 * 在 preload 里调用：建立本进程独占目录、把 TMPDIR 指过去、注册整轮测试结束后的删除。
 * 必须在任何测试文件（含其模块顶层）调用 `tmpdir()` 之前执行——preload 就是这个时机。
 */
export function installIsolatedTmpDir(repoRoot: string): string {
  const parent = join(repoRoot, "tmp");
  mkdirSync(parent, { recursive: true });
  pruneStaleTestTmpDirs(parent);

  const dir = testTmpRunDir(repoRoot);
  // 同 pid 复用（上一次进程被 kill）时先清空，保证本轮从空目录开始。
  removeQuietly(dir);
  mkdirSync(dir, { recursive: true });

  process.env.TMPDIR = dir;
  if (process.platform === "win32") {
    // Windows 上 os.tmpdir() 读 TEMP/TMP，不读 TMPDIR。
    process.env.TMP = dir;
    process.env.TEMP = dir;
  }

  afterAll(() => {
    removeQuietly(dir);
  });
  return dir;
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但不属于当前用户
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function removeQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // 删不掉不阻塞测试：下一次 preload 的 prune 会兜住这个目录。
  }
}
