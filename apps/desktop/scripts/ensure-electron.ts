#!/usr/bin/env bun
/**
 * #111：保证 `node_modules/electron` 里真的有二进制（`dist/` + `path.txt`）。
 *
 * 根因不是「bun 不跑 postinstall」那么简单：electron@45 的 npm 包里**没有** `postinstall`
 * 脚本（只有 bin `install-electron`），所以任何包管理器装完都只留下 JS 壳，
 * `bun run dev` / electron-vite 会直接报 `Error: Electron uninstall`。
 * 根 package.json 的 `trustedDependencies: ["electron"]` 是「将来 electron 恢复 postinstall 时照跑」
 * 的前置声明；真正的兜底是这里：幂等地补跑 electron 自带的 `install.js`。
 *
 * 行为：
 * - 已装好（dist/version 与包版本一致、path.txt 对得上、可执行文件存在）→ 立刻退出，不联网；
 * - 缺二进制 → 用当前 runtime 跑 electron 的 install.js（@electron/get 走标准 proxy 环境变量，带缓存）；
 * - 安装失败只警告不阻断 `bun install`：给出可复制的修复命令，让 `bun run dev` 自己报错更具体。
 * - 设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`（CI 只要打包不需要跑 app 时）直接跳过。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const PLATFORM_PATH: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "Electron.app/Contents/MacOS/Electron",
  win32: "electron.exe",
  linux: "electron",
};

type ElectronPackage = { dir: string; version: string; binPath: string };

function findElectron(): ElectronPackage | null {
  for (const dir of [join(REPO_ROOT, "apps/desktop/node_modules/electron"), join(REPO_ROOT, "node_modules/electron")]) {
    const manifest = join(dir, "package.json");
    const installScript = join(dir, "install.js");
    if (!existsSync(manifest) || !existsSync(installScript)) continue;
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
    if (typeof parsed.version !== "string") continue;
    return { dir, version: parsed.version, binPath: join(dir, "install.js") };
  }
  return null;
}

/** 与 electron 自己 install.js 的 `isInstalled()` 同口径：版本、path.txt、可执行文件三者都对。 */
function isInstalled(pkg: ElectronPackage): boolean {
  const platformPath = PLATFORM_PATH[process.platform];
  if (platformPath === undefined) return false;
  const distVersion = join(pkg.dir, "dist/version");
  const pathFile = join(pkg.dir, "path.txt");
  try {
    if (readFileSync(distVersion, "utf8").replace(/^v/, "") !== pkg.version) return false;
    if (readFileSync(pathFile, "utf8") !== platformPath) return false;
  } catch {
    return false;
  }
  return existsSync(join(pkg.dir, "dist", platformPath));
}

function main(): void {
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === "1") {
    console.log("electron 二进制：ELECTRON_SKIP_BINARY_DOWNLOAD=1，跳过");
    return;
  }
  const pkg = findElectron();
  if (pkg === null) {
    // electron 没装（例如只装了部分 workspace）：不猜路径，交给后面的 `bun run dev` 报错。
    console.warn("electron 二进制：node_modules 里没有 electron 包，跳过补齐");
    return;
  }
  if (isInstalled(pkg)) return;
  console.log(`electron 二进制缺失，补装 electron@${pkg.version}（${process.platform}/${process.arch}）…`);
  const result = spawnSync(process.execPath, [pkg.binPath], { cwd: pkg.dir, stdio: "inherit" });
  if (result.status === 0 && isInstalled(pkg)) {
    console.log(`electron 二进制就绪：${pkg.version}`);
    return;
  }
  console.warn(
    [
      "electron 二进制补装失败（#111）：`bun run dev` 会报 Error: Electron uninstall。",
      "手动修复：cd apps/desktop && node node_modules/electron/install.js",
      "网络受限时确认 http_proxy / https_proxy 已生效（@electron/get 读标准环境变量）。",
    ].join("\n"),
  );
}

main();
