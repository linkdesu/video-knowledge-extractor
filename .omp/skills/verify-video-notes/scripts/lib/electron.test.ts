/**
 * 新 worktree 装不上 Electron（r58 验收 4）。
 *
 * `bun install` 在全新 worktree 里只链接 `node_modules/electron`，不下载 `dist/`，
 * 于是 `up` 报 "Electron binary not found"。这里把自愈逻辑拆成可注入命令的纯逻辑：
 * 先找现成的二进制，找不到就补跑包自带的 `install.js`（必要时先 `bun install`），
 * 仍然失败时给出可以直接复制执行的命令。
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { electronCandidates, ensureElectronBinary, ElectronBootstrapError, findElectronBinary } from "./electron";

// 用 join 拼期望值：CI 的 Windows runner 上 path.join 产出反斜杠，写死 "/" 的断言只在 mac 成立
const REPO = join("repo");
const DESKTOP = join(REPO, "apps", "desktop");
const DESKTOP_PKG = join(DESKTOP, "node_modules", "electron");
const ROOT_PKG = join(REPO, "node_modules", "electron");
const ELECTRON_REL = join("dist", "Electron.app", "Contents", "MacOS", "Electron");
const DESKTOP_BINARY = join(DESKTOP_PKG, ELECTRON_REL);
const ROOT_BINARY = join(ROOT_PKG, ELECTRON_REL);

function harness(present: string[], scripts: Array<{ on: (cmd: string[]) => void; code?: number; stderr?: string }>) {
  const files = new Set(present);
  const calls: Array<{ command: string[]; cwd: string }> = [];
  const logs: string[] = [];
  let step = 0;
  return {
    files,
    calls,
    logs,
    deps: {
      exists: (path: string) => files.has(path),
      run: (command: string[], cwd: string) => {
        calls.push({ command, cwd });
        const script = scripts[step];
        step += 1;
        script?.on(command);
        return { code: script?.code ?? 0, stderr: script?.stderr ?? "" };
      },
      log: (line: string) => logs.push(line),
    },
  };
}

const installJs = (desktop = true) => join(desktop ? DESKTOP_PKG : ROOT_PKG, "install.js");

describe("electronCandidates", () => {
  test("先看 apps/desktop 自己的 node_modules，再看根 node_modules", () => {
    expect(electronCandidates(REPO, DESKTOP).map((entry) => entry.binary)).toEqual([DESKTOP_BINARY, ROOT_BINARY]);
    expect(electronCandidates(REPO, DESKTOP)[0]?.pkgDir).toBe(DESKTOP_PKG);
  });
});

describe("findElectronBinary", () => {
  test("桌面包的 dist 存在时直接用它", () => {
    expect(findElectronBinary(REPO, DESKTOP, (path) => path === DESKTOP_BINARY)?.binary).toBe(DESKTOP_BINARY);
  });

  test("只有一个候选存在时返回它", () => {
    expect(findElectronBinary(REPO, DESKTOP, (path) => path === ROOT_BINARY)?.binary).toBe(ROOT_BINARY);
  });

  test("都没有时返回 null", () => {
    expect(findElectronBinary(REPO, DESKTOP, () => false)).toBeNull();
  });
});

describe("ensureElectronBinary", () => {
  test("二进制已在：不跑任何命令", () => {
    const h = harness([DESKTOP_BINARY], []);
    const result = ensureElectronBinary(REPO, DESKTOP, h.deps);
    expect(result).toEqual({ binary: DESKTOP_BINARY, installed: false, steps: [] });
    expect(h.calls).toEqual([]);
  });

  test("只链接了包、没有 dist：补跑 install.js（验收 4 的真实场景）", () => {
    const h = harness([installJs()], [
      {
        on: () => h.files.add(DESKTOP_BINARY),
      },
    ]);
    const result = ensureElectronBinary(REPO, DESKTOP, h.deps);
    expect(result.installed).toBe(true);
    expect(result.binary).toBe(DESKTOP_BINARY);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.command.at(-1)).toBe("install.js");
    expect(h.calls[0]?.cwd).toBe(DESKTOP_PKG);
    // 运行时给出一条可读的进度行，而不是静默几十秒
    expect(h.logs.join("\n")).toContain("Electron");
  });

  test("node 不可用时退回 bun 执行 install.js", () => {
    const h = harness([installJs()], [
      { on: () => {}, code: 127, stderr: "spawn node ENOENT" },
      { on: () => h.files.add(DESKTOP_BINARY) },
    ]);
    const result = ensureElectronBinary(REPO, DESKTOP, h.deps);
    expect(result.binary).toBe(DESKTOP_BINARY);
    expect(h.calls.map((call) => call.command[0])).toEqual(["node", "bun"]);
  });

  test("连 electron 包都没有：先 bun install，再补 install.js", () => {
    const h = harness([], [
      { on: () => h.files.add(installJs()) },
      { on: () => h.files.add(DESKTOP_BINARY) },
    ]);
    const result = ensureElectronBinary(REPO, DESKTOP, h.deps);
    expect(result.binary).toBe(DESKTOP_BINARY);
    expect(h.calls.map((call) => call.command)).toEqual([["bun", "install"], ["node", "install.js"]]);
    expect(h.calls[0]?.cwd).toBe(REPO);
  });

  test("bun install 之后仍然没有 electron 包：抛错并给出命令", () => {
    const h = harness([], [{ on: () => {} }]);
    expect(() => ensureElectronBinary(REPO, DESKTOP, h.deps)).toThrow(ElectronBootstrapError);
    let message = "";
    try {
      ensureElectronBinary(REPO, DESKTOP, h.deps);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("bun install");
    expect(message).toContain("node_modules/electron");
  });

  test("install.js 失败：错误里带 stderr 尾巴和手抄命令", () => {
    const h = harness([installJs()], [{ on: () => {}, code: 1, stderr: "request to registry failed: ECONNRESET" }]);
    let message = "";
    try {
      ensureElectronBinary(REPO, DESKTOP, h.deps);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
      expect(err).toBeInstanceOf(ElectronBootstrapError);
    }
    expect(message).toContain("ECONNRESET");
    expect(message).toContain(`node ${join("apps", "desktop", "node_modules", "electron", "install.js")}`);
    expect(message).toContain("HTTPS_PROXY");
  });

  test("install.js 退出 0 但 dist 仍缺：错误点到 dist 路径", () => {
    const h = harness([installJs()], [{ on: () => {} }]);
    expect(() => ensureElectronBinary(REPO, DESKTOP, h.deps)).toThrow(ElectronBootstrapError);
    let message = "";
    try {
      ensureElectronBinary(REPO, DESKTOP, h.deps);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(ELECTRON_REL);
  });
});
