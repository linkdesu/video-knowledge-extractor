/**
 * app.asar 清单校验（r72 / #96）：包内只允许运行时文件。
 *
 * 故障来源（#96 / CI run 41402337086）：`electron-builder` 收集依赖时先看 app 目录
 * （`release-win/stage`），stage 的 package.json 没写 dependencies，于是「no node modules
 * found in collection」后回退到 `apps/desktop`，把 workspace 链接的 `@video-notes/core`
 * （整份 `src/**`、`*.test.ts`、`__snapshots__`、`packages/core/.turbo/*.log`）和它依赖的
 * `dotenv` 一起塞进 asar：Windows 包 156 项，Mac 包 36 项。
 *
 * 这里的规则是**白名单**，不枚举坏文件：白名单外的任何条目都算失败，
 * 所以以后再冒出新来源（新依赖、构建缓存、别的 workspace）都会在 CI 直接红。
 *
 * 纯函数 + 依赖注入（清单由调用方传入），文件读取只放 `readAsarEntries`。
 */

import { closeSync, openSync, readSync } from "node:fs";

/** 打包目标平台；macOS 只出 arm64。 */
export type AppPlatform = "win32" | "darwin";

/** 每个平台唯一的原生包目录名（与 scripts/package-*.ts 的 staging 一致）。 */
export const PLATFORM_NATIVE_PACKAGE: Record<AppPlatform, string> = {
  win32: "sherpa-onnx-win-x64",
  darwin: "sherpa-onnx-darwin-arm64",
};

/** 白名单：只有这些前缀允许进 asar。 */
export function allowedPrefixes(platform: AppPlatform): string[] {
  return [
    "out/",
    "package.json",
    "node_modules/sherpa-onnx-node/",
    `node_modules/${PLATFORM_NATIVE_PACKAGE[platform]}/`,
  ];
}

/** 运行时缺一不可的条目（防止「空 asar 也过白名单」这种假通过）。 */
export function requiredEntries(platform: AppPlatform): string[] {
  return [
    "package.json",
    "out/main/index.js",
    "out/preload/index.cjs",
    "node_modules/sherpa-onnx-node/package.json",
    `node_modules/${PLATFORM_NATIVE_PACKAGE[platform]}/package.json`,
  ];
}

export interface ManifestVerdict {
  ok: boolean;
  platform: AppPlatform;
  total: number;
  /** 按顶层分组计数（`out`、`package.json`、sherpa 包名、`白名单外`）。 */
  counts: Record<string, number>;
  problems: string[];
}

/** asar 头部的 JSON 就是清单本身；`16` 起点与 `offset 12` 的「JSON 字节数」是 chromium pickle 的固定布局。 */
export function readAsarEntries(asarPath: string): string[] {
  const fd = openSync(asarPath, "r");
  try {
    const head = Buffer.alloc(16);
    if (readSync(fd, head, 0, 16, 0) !== 16) throw new Error(`${asarPath} 太小，不是 asar`);
    if (head.readUInt32LE(0) !== 4) {
      throw new Error(`${asarPath} 的头不是 asar 格式（首字段应为 4，实际 ${head.readUInt32LE(0)}）`);
    }
    const jsonLength = head.readUInt32LE(12);
    if (jsonLength === 0 || jsonLength > 64 * 1024 * 1024) {
      throw new Error(`${asarPath} 的清单长度不合理：${jsonLength}`);
    }
    const raw = Buffer.alloc(jsonLength);
    if (readSync(fd, raw, 0, jsonLength, 16) !== jsonLength) {
      throw new Error(`${asarPath} 的清单被截断（期望 ${jsonLength} 字节）`);
    }
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    const root = childFileTree(parsed);
    if (root === null) throw new Error(`${asarPath} 的清单缺少 files`);
    const entries: string[] = [];
    walk(root, "", entries);
    return entries;
  } finally {
    closeSync(fd);
  }
}

/** asar 节点形状：`{ files: { 名字: 节点 } }`。不是这个形状就是叶子（文件），返回 null。 */
function childFileTree(node: unknown): Record<string, unknown> | null {
  if (node === null || typeof node !== "object" || !("files" in node)) return null;
  const files = node.files;
  if (files === null || typeof files !== "object" || Array.isArray(files)) return null;
  // 上面已排除 null/标量/数组：JSON 解析出的目录节点就是「名字 → 节点」的普通对象。
  const tree: Record<string, unknown> = files as Record<string, unknown>;
  return tree;
}

function walk(tree: Record<string, unknown>, prefix: string, out: string[]): void {
  for (const name of Object.keys(tree)) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const children = childFileTree(tree[name]);
    if (children === null) out.push(path);
    else walk(children, path, out);
  }
}

/** 归一化：去前导 `/`、去尾部 `/`，供白名单与跨平台比对共用。 */
export function normalizeEntry(entry: string): string {
  return entry.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** 白名单外的条目给一句人话原因，报告里直接能看到「多带了什么、为什么不该带」。 */
export function explainUnexpected(entry: string, platform: AppPlatform): string {
  const path = normalizeEntry(entry);
  if (/\.turbo\//.test(path)) return "turbo 构建缓存/日志";
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return "测试文件";
  if (/__snapshots__\//.test(path) || /\.snap$/.test(path)) return "测试快照";
  if (/\.log$/.test(path)) return "日志文件";
  if (/(^|\/)node_modules\/dotenv\//.test(path)) return "npm 依赖 dotenv（core 的运行期依赖，desktop 不需要）";
  if (/(^|\/)node_modules\/@video-notes\//.test(path)) {
    return "workspace 源码（@video-notes/core 已打进 out/ 的 bundle）";
  }
  if (/\.ts$/.test(path) && /\/src\//.test(path)) return "TypeScript 源码（应已被 bundle）";
  if (/node_modules\/sherpa-onnx-(?!node)/.test(path)) {
    return "其它平台的原生包（当前只打包 " + PLATFORM_NATIVE_PACKAGE[platform] + "）";
  }
  return "白名单外";
}

export function judgeAsarManifest(entries: readonly string[], platform: AppPlatform): ManifestVerdict {
  const allowed = allowedPrefixes(platform);
  const counts: Record<string, number> = {};
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const raw of entries) {
    const path = normalizeEntry(raw);
    if (path === "") continue;
    seen.add(path);
    const prefix = allowed.find((candidate) => path === candidate || path.startsWith(candidate));
    const group = prefix === undefined ? "白名单外" : prefix.replace(/\/$/, "");
    counts[group] = (counts[group] ?? 0) + 1;
    if (prefix === undefined) problems.push(`多带：${path} —— ${explainUnexpected(path, platform)}`);
  }

  for (const required of requiredEntries(platform)) {
    if (!seen.has(required)) problems.push(`缺少运行时文件：${required}`);
  }

  return { ok: problems.length === 0, platform, total: seen.size, counts, problems };
}

/**
 * 跨平台「形状」：比对两个平台的运行时结构，去掉两类天生不同的东西：
 *  - 各平台唯一的原生包目录折叠成一个标记 `node_modules/<native>`（DLL 名与 dylib 名本来就不同）；
 *  - `*.md` 文档（@electron/packager 原样复制 stage，electron-builder 的依赖收集会略过它们）。
 * 白名单（judgeAsarManifest）仍然逐条管住所有文件，这里只管「Windows 与 mac 结构是否一致」。
 */
export function manifestShape(entries: readonly string[], platform: AppPlatform): string[] {
  const native = `node_modules/${PLATFORM_NATIVE_PACKAGE[platform]}/`;
  const shape = new Set<string>();
  for (const raw of entries) {
    const entry = normalizeEntry(raw);
    if (entry === "" || entry.endsWith(".md")) continue;
    shape.add(entry.startsWith(native) ? "node_modules/<native>" : entry);
  }
  return [...shape].sort();
}

export interface ShapeDiff {
  onlyInLeft: string[];
  onlyInRight: string[];
}

export function diffManifestShape(left: readonly string[], right: readonly string[]): ShapeDiff {
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  return {
    onlyInLeft: left.filter((entry) => !rightSet.has(entry)),
    onlyInRight: right.filter((entry) => !leftSet.has(entry)),
  };
}
