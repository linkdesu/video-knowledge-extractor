import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpRegistry } from "./temp-dirs-preload";

/**
 * 测试临时目录的唯一入口（#101）：禁止测试再用
 * `mkdtempSync(join(tmpdir(), …))` / `join(tmpdir(), …)` 裸建目录——那样没人删，
 * 曾经把系统 `$TMPDIR` 堆到 109.6 GB / 73 万个目录。
 *
 * 两个函数按生命周期区分，选错会让后续用例看到已被删除的目录：
 * - `makeTmpDir`：用例级，当前用例结束（preload 注册的 `afterEach`）即删除；
 * - `makeSuiteTmpDir`：文件级共享夹具（模块顶层或 `beforeAll` 里建），整轮测试结束才删。
 *
 * 目录建在 `os.tmpdir()` 下；测试进程的 `os.tmpdir()` 已由 preload
 * （`./temp-dirs-preload`）指到 `<repo>/tmp/test-<pid>`，所以即使清理漏了也不会落到系统临时目录。
 *
 * 清理钩子刻意不写在这里：bun 会缓存模块，hooks 只在第一个导入本模块的测试文件里
 * 生效，必须由 preload 统一注册（见 `./temp-dirs-preload` 的说明）。
 */
export function makeTmpDir(prefix: string, base: string = tmpdir()): string {
  return createTmpDir(prefix, base, "perTest");
}

/** 建一个整份测试文件共享的临时目录（模块顶层 / `beforeAll` 用）。 */
export function makeSuiteTmpDir(prefix: string, base: string = tmpdir()): string {
  return createTmpDir(prefix, base, "perSuite");
}

function createTmpDir(prefix: string, base: string, lane: "perTest" | "perSuite"): string {
  const registry = requireIsolation();
  // bun test 从深层子目录运行时不会加载 bunfig（也就没有 preload），此时宽松地照建目录
  // 等于把 #101 的泄漏原样放回来，所以宁可立刻失败。
  // 另外 `--no-isolate` 复用 worker 时运行目录可能已被上一个文件的 afterAll 删掉，建一次无害。
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, prefix));
  registry[lane].push(dir);
  return dir;
}

function requireIsolation() {
  const registry = tmpRegistry();
  if (registry.runDir === undefined) {
    throw new Error(
      "测试临时目录未隔离：当前 `bun test` 没有加载 test-preload.ts。" +
        "请从包目录（packages/core / apps/desktop / apps/cli）或仓库根运行 bun test，" +
        "并确认该目录的 bunfig.toml 有 [test] preload = [\"./test-preload.ts\"]。",
    );
  }
  return registry;
}
