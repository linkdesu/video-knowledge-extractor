/**
 * 打包 macOS arm64 试用版（未签名）：out/ + sherpa 原生包 → app.asar → .app → .dmg。
 *
 * 为什么自己 staging 而不是直接让打包器扫 workspace：
 * bun 的 node_modules 是符号链接布局，`@video-notes/core` 是 workspace 包（已打进 bundle），
 * 依赖树里还有 6 个平台包只装了 darwin-arm64。这里把「运行时真正需要的文件」显式复制到
 * release/stage，不依赖打包器的依赖推断，产物可复现。
 *
 * 用法：`bun run package:mac`（先 electron-vite build）。产物在 apps/desktop/release/，不进 git。
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { packager } from "@electron/packager";

const APP_NAME = "Video Notes";
const BUNDLE_ID = "me.xieal.video-notes";
/** asar 里必须解包的原生目录：.node 与 dylib 不能被 asar 的虚拟文件系统加载。 */
const NATIVE_UNPACK = "**/node_modules/sherpa-onnx-*/**";

const appDir = resolve(import.meta.dirname, "..");
const releaseDir = join(appDir, "release");
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
  `${JSON.stringify(
    {
      name: "video-notes",
      productName: APP_NAME,
      version,
      description: "把长视频变成可按主题阅读的笔记",
      main: "out/main/index.js",
      type: "module",
      private: true,
    },
    null,
    2,
  )}\n`,
);

const sherpaDir = realpathSync(dirname(requireFromApp.resolve("sherpa-onnx-node")));
const platformDir = join(dirname(sherpaDir), "sherpa-onnx-darwin-arm64");
if (!existsSync(platformDir)) {
  throw new Error(`找不到 sherpa-onnx-darwin-arm64（期望在 ${platformDir}）：原生包未安装，无法打包`);
}
cpSync(sherpaDir, join(stageDir, "node_modules", "sherpa-onnx-node"), { recursive: true, dereference: true });
cpSync(platformDir, join(stageDir, "node_modules", "sherpa-onnx-darwin-arm64"), { recursive: true, dereference: true });

// 2) .app
const electronVersion = packageVersion(requireFromApp.resolve("electron/package.json"));
const appPaths = await packager({
  dir: stageDir,
  out: releaseDir,
  platform: "darwin",
  arch: "arm64",
  name: APP_NAME,
  appBundleId: BUNDLE_ID,
  appCategoryType: "public.app-category.productivity",
  electronVersion,
  overwrite: true,
  prune: false,
  derefSymlinks: true,
  asar: { unpack: NATIVE_UNPACK },
  // 试用版不签名：不给 osxSign，打包器就不调用签名工具（也就不会弹钥匙串）
  quiet: true,
});
const appPath = appPaths[0];
if (appPath === undefined) throw new Error("打包器没有返回 .app 路径");

// 3) .dmg（hdiutil 是系统自带，不引入额外工具）
const dmgPath = join(releaseDir, `${APP_NAME}-${version}-arm64.dmg`);
// 上一次失败的 DMG 可能仍被 Spotlight/挂载引用；先删再建，保证可重复
rmSync(dmgPath, { force: true });
try {
  execFileSync("hdiutil", ["create", "-volname", APP_NAME, "-srcfolder", appPath, "-ov", "-format", "UDZO", dmgPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (err) {
  const stderr = err instanceof Error && "stderr" in err && Buffer.isBuffer(err.stderr) ? err.stderr.toString().trim() : String(err);
  throw new Error(`hdiutil 失败：${stderr}`);
}

console.log(JSON.stringify({ appPath, dmgPath, bundleId: BUNDLE_ID, electronVersion }, null, 2));
