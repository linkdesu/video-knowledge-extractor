import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach } from "bun:test";

/**
 * 测试进程的 TMPDIR 隔离与临时目录清理（#101）。
 *
 * 1. 每个 `bun test` 进程独占 `<repo>/tmp/test-<pid>` 作为 TMPDIR；preload 里调用
 *    `installIsolatedTmpDir(repoRoot)` 后，`os.tmpdir()` 及其下游的
 *    `mkdtempSync(tmpdir(), …)` 全部落在仓库内，不再堆进系统 `$TMPDIR`
 *    （历史事故：53 个测试文件 119 处 mkdtemp 从不删除，一度占用 109.6 GB）。
 * 2. 清理钩子**必须注册在 preload 作用域**：bun 1.4 不重置模块注册表，同一个
 *    helper 模块只在第一个导入它的测试文件里求值一次，注册在那里的 `afterEach`
 *    只对那个文件生效——其余文件建的目录会活到整轮结束。preload 的
 *    `afterEach` 则是全局的，每个用例结束后都执行（实测）。
 * 3. `bun test` 不会触发 `process.on("exit")`（实测 1.4.0），所以整轮删目录挂在
 *    preload 的 `afterAll` 上。进程被 kill / 崩溃时清理不到，由下一次 preload 的
 *    `pruneStaleTestTmpDirs` 兜住（死 pid 与超龄目录）。
 */

/**
 * 活进程目录的兜底年龄：pid 被复用后旧目录可能永远等不到死 pid。
 * 阈值取得比任何一次测试运行都长得多（7 天），避免把挂起/调试中的进程夹具删掉。
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const RUN_DIR_NAME = /^test-(\d+)$/;

/**
 * 用例级 / 文件级待删目录的登记表。放在 globalThis 上是因为 helper 模块会被缓存，
 * preload 与测试文件必须看到同一个数组。
 */
const REGISTRY = Symbol.for("vnote.test.tmpdirs");

export interface TmpRegistry {
  /** 本进程独占的运行目录；undefined 表示 preload 未安装（helper 会直接报错）。 */
  runDir?: string;
  perTest: string[];
  perSuite: string[];
}

export interface PruneOptions {
  /** 判定 pid 是否存活；测试注入用。 */
  isAlive?: (pid: number) => boolean;
  maxAgeMs?: number;
}

/** 取（必要时创建）全局登记表；preload 与 `@video-notes/core/testing` 共用。 */
export function tmpRegistry(): TmpRegistry {
  const store = globalThis as typeof globalThis & { [REGISTRY]?: TmpRegistry };
  let existing = store[REGISTRY];
  if (existing === undefined) {
    existing = { perTest: [], perSuite: [] };
    store[REGISTRY] = existing;
  }
  return existing;
}

/** 本进程独占的测试临时目录：`<repo>/tmp/test-<pid>`。 */
export function testTmpRunDir(repoRoot: string): string {
  return join(repoRoot, "tmp", `test-${process.pid}`);
}

/**
 * 清掉 `<repo>/tmp` 下残留的 `test-<pid>` 目录：死进程的目录直接删；
 * 活进程的目录只在超过 `maxAgeMs`（默认 7 天）时删，作为 pid 复用的兜底。
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
 * 在 preload 里调用：建立本进程独占目录、把 TMPDIR 指过去、注册
 * 「每个用例结束后删用例级目录 / 整轮结束后删文件级目录与整个运行目录」。
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

  const registry = tmpRegistry();
  registry.runDir = dir;
  afterEach(() => {
    drain(registry.perTest);
  });
  afterAll(() => {
    drain(registry.perTest);
    drain(registry.perSuite);
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

function drain(dirs: string[]): void {
  while (dirs.length > 0) {
    removeQuietly(dirs.pop()!);
  }
}

function removeQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // 删不掉不阻塞测试：下一次 preload 的 prune 会兜住这个目录。
  }
}
