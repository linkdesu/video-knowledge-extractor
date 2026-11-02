import { mkdtempSync } from "node:fs";
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
 * （`./tmp-root`）指到 `<repo>/tmp/test-<pid>`，所以即使清理漏了也不会落到系统临时目录。
 *
 * 清理钩子刻意不写在这里：bun 会缓存模块，hooks 只在第一个导入本模块的测试文件里
 * 生效，必须由 preload 统一注册（见 `./tmp-root` 的说明）。
 */

/** 建一个只属于当前用例的临时目录。 */
export function makeTmpDir(prefix: string, base: string = tmpdir()): string {
  const dir = mkdtempSync(join(base, prefix));
  tmpRegistry().perTest.push(dir);
  return dir;
}

/** 建一个整份测试文件共享的临时目录（模块顶层 / `beforeAll` 用）。 */
export function makeSuiteTmpDir(prefix: string, base: string = tmpdir()): string {
  const dir = mkdtempSync(join(base, prefix));
  tmpRegistry().perSuite.push(dir);
  return dir;
}
