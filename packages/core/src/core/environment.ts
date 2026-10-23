import { statSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { cacheRoot, modelDir, notesRoot } from "./config";
import type { Logger } from "./logger";
import { modelFileSpecs } from "../asr/sherpa";

export type PathCheck = { role: string; path: string; exists: boolean; bytes: number | null; nonAscii: boolean; hasSpace: boolean };
export type EnvironmentSnapshot = {
  at: string; appVersion: string | null; commit: string | null;
  platform: string; release: string; arch: string; cpuModel: string | null; cpuCount: number; totalMemBytes: number; gpu: string | null;
  tools: PathCheck[]; models: PathCheck[]; dirs: PathCheck[];
};

// win32 的 PATH 分隔符是 ;，可执行文件带 .exe 后缀（r34 排查项）
export function findExecutable(name: string, opts?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): string | null {
  const platformName = opts?.platform ?? process.platform;
  const env = opts?.env ?? process.env;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const sep = platformName === "win32" ? ";" : ":";
  const candidates = platformName === "win32" ? [`${name}.exe`] : [name];
  for (const dir of pathValue.split(sep)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const abs = resolve(dir, candidate);
      try {
        if (statSync(abs).isFile()) return abs;
      } catch {
        // 不存在或不可访问，继续
      }
    }
  }
  return null;
}

// 目录没有有意义的大小，bytes 记 null
export function checkPath(role: string, path: string): PathCheck {
  const check: PathCheck = {
    role,
    path,
    exists: false,
    bytes: null,
    nonAscii: /[^\u0000-\u007f]/.test(path),
    hasSpace: path.includes(" "),
  };
  try {
    const stat = statSync(path);
    check.exists = true;
    if (stat.isFile()) check.bytes = stat.size;
  } catch {
    // ENOENT 等：保持 exists false
  }
  return check;
}

export function collectEnvironment(opts?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  appVersion?: string | null;
  commit?: string | null;
  gpu?: string | null;
  modelDir?: string;
  extraDirs?: { role: string; path: string }[];
}): EnvironmentSnapshot {
  const platformName = opts?.platform ?? process.platform;
  const env = opts?.env ?? process.env;
  const tools = ["ffmpeg", "ffprobe"].map((name) => checkPath(name, findExecutable(name, { env, platform: platformName }) ?? name));
  const models = modelFileSpecs(opts?.modelDir ?? modelDir()).map((spec) => checkPath(spec.role, spec.path));
  const dirs: PathCheck[] = [
    checkPath("notesRoot", notesRoot()),
    checkPath("cacheRoot", cacheRoot()),
    checkPath("modelDir", modelDir()),
  ];
  for (const extra of opts?.extraDirs ?? []) dirs.push(checkPath(extra.role, extra.path));
  const cpuList = cpus();
  return {
    at: new Date().toISOString(),
    appVersion: opts?.appVersion ?? null,
    commit: opts?.commit ?? null,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: cpuList[0]?.model ?? null,
    cpuCount: cpuList.length,
    totalMemBytes: totalmem(),
    gpu: opts?.gpu ?? null,
    tools,
    models,
    dirs,
  };
}

export function formatEnvironment(snapshot: EnvironmentSnapshot): string[] {
  return [...snapshot.tools, ...snapshot.models, ...snapshot.dirs].map((check) => {
    const parts = [check.exists ? "exists" : "missing"];
    parts.push(check.bytes === null ? "?" : `${check.bytes} bytes`);
    if (check.nonAscii) parts.push("非 ASCII");
    if (check.hasSpace) parts.push("含空格");
    return `${check.role}: ${check.path} (${parts.join(", ")})`;
  });
}

export function logEnvironment(log: Logger, snapshot: EnvironmentSnapshot): void {
  for (const line of formatEnvironment(snapshot)) log.info("env", line);
}
