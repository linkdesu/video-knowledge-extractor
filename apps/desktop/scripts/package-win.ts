/**
 * 打包 Windows x64 NSIS 安装包（未签名）：out/ + sherpa 原生包 → staging → electron-builder。
 *
 * staging 策略与 package-mac.ts 相同：bun 的 node_modules 是符号链接布局，
 * `@video-notes/core` 已打进 bundle，这里只显式复制运行时真正需要的文件，不依赖打包器的依赖推断。
 *
 * 注意：sherpa-onnx-win-x64 是 optionalDependencies，只在 win32/x64 上安装；
 * 在 macOS 上运行本脚本会明确报错并以非零退出（这是预期的，本机只用来验证流程）。
 *
 * 用法：`bun run package:win`（先 electron-vite build，并先跑 fetch:ffmpeg）。
 * 产物在 apps/desktop/release-win/，不进 git。
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  APP_PRODUCT_NAME,
  builderMetadataOverrides,
  stagePackageJson,
} from "./app-metadata";

const appDir = resolve(import.meta.dirname, "..");
const releaseDir = join(appDir, "release-win");
const stageDir = join(releaseDir, "stage");
const requireFromApp = createRequire(join(appDir, "package.json"));

/** 从 package.json 读 version，形状不对就报可读错误（不猜字段）。 */
function packageVersion(path: string): string {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || typeof parsed.version !== "string") {
    throw new Error(`${path} 缺少字符串 version`);
  }
  return parsed.version;
}

const version = packageVersion(join(appDir, "package.json"));

if (!existsSync(join(appDir, "out/main/index.js"))) {
  throw new Error("out/ 不存在：先跑 `bun run build`");
}

// 1) staging：只放运行时需要的东西
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(join(stageDir, "node_modules"), { recursive: true });
cpSync(join(appDir, "out"), join(stageDir, "out"), { recursive: true, dereference: true });
writeFileSync(
  join(stageDir, "package.json"),
  `${JSON.stringify(stagePackageJson(version), null, 2)}\n`,
);

const sherpaDir = realpathSync(dirname(requireFromApp.resolve("sherpa-onnx-node")));
const platformDir = join(dirname(sherpaDir), "sherpa-onnx-win-x64");
if (!existsSync(platformDir)) {
  throw new Error(
    `找不到 sherpa-onnx-win-x64（期望在 ${platformDir}）：它是 optional 平台包，只在 win32/x64 上安装，` +
      `在 macOS 上本机打包不可行，请在 Windows CI 上运行`,
  );
}
cpSync(sherpaDir, join(stageDir, "node_modules", "sherpa-onnx-node"), { recursive: true, dereference: true });
cpSync(platformDir, join(stageDir, "node_modules", "sherpa-onnx-win-x64"), { recursive: true, dereference: true });

// 2) electron-builder 走 CLI，输出流式透传，方便 CI 直接看到进度
const child = spawn(
  "node_modules/.bin/electron-builder",
  ["--win", "nsis", "--x64", "--config", "electron-builder.yml", ...builderMetadataOverrides()],
  { cwd: appDir, stdio: "inherit" },
);
const code = await new Promise<number>((resolvePromise) => {
  child.on("exit", (c) => resolvePromise(c ?? 1));
});
if (code !== 0) {
  throw new Error(`electron-builder 退出码 ${code}`);
}

// 3) 找到产物 .exe（electron-builder 输出在 release-win/，排除 staging）
const outExe = join(releaseDir, `${APP_PRODUCT_NAME}-${version}-setup.exe`);
if (!existsSync(outExe)) {
  const found = readdirSync(releaseDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".exe") && !(f.split(/[/\\]/)[0] ?? "").startsWith("stage"));
  throw new Error(`没找到预期产物 ${outExe}，release-win/ 下的 exe：${JSON.stringify(found)}`);
}
console.log(JSON.stringify({ exePath: outExe, version }, null, 2));
