import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ImportResult, ModelBundle } from "./catalog";
import { MODEL_BUNDLES, modelStatus } from "./catalog";
import { assertInsideModelDir, extractArchive, streamSha256 } from "./extract";
import { verifyBundle } from "./verify";
import { logger } from "../core/logger";
/**
 * 导入模型（ADR-0015 §4）：目录 / .tar.bz2 归档 / 单文件三种输入。
 * 目录先按清单完整相对路径查找，找不到再按 basename+sha256 匹配。
 * 一个包全部文件通过才安装，否则 rejected 带原因。
 */
export async function importModels(
  modelDirArg: string,
  sourcePath: string,
  bundles: readonly ModelBundle[] = MODEL_BUNDLES,
): Promise<ImportResult> {
  const modelDir = resolve(modelDirArg);
  mkdirSync(modelDir, { recursive: true });
  const sourceStat = statSync(sourcePath);
  const isDir = sourceStat.isDirectory();
  for (const bundle of bundles) for (const spec of bundle.files) assertInsideModelDir(modelDir, spec.path);
  const isArchive = !isDir && sourcePath.endsWith(".tar.bz2");

  const installed: string[] = [];
  const rejected: { bundleId: string; reason: string }[] = [];
  for (const bundle of bundles) {
    // 每个包一条结果行：ok、文件数、耗时；失败另记 error 带 stack
    const startedAt = Date.now();
    try {
      await installImportedBundle(modelDir, sourcePath, bundle, isDir, isArchive);
      installed.push(bundle.id);
      logger().info("import", "模型包导入完成", { role: bundle.id, file: bundle.files.map((f) => f.path).join(","), ok: true, bytes: sourceStat.size, durationMs: Date.now() - startedAt });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      rejected.push({ bundleId: bundle.id, reason });
      logger().info("import", "模型包导入完成", { role: bundle.id, file: bundle.files.map((f) => f.path).join(","), ok: false, bytes: sourceStat.size, durationMs: Date.now() - startedAt });
      logger().error("import", "模型包导入失败", { role: bundle.id, error: reason, stack: err instanceof Error ? err.stack : undefined });
    }
  }
  // 已安装的包按清单校验并把结果写进缓存
  if (installed.length > 0) await verifyBundle(modelDir, bundles.filter((b) => installed.includes(b.id)));
  return { installed, rejected, status: modelStatus(modelDirArg, bundles) };
}

async function installImportedBundle(
  modelDir: string,
  sourcePath: string,
  bundle: ModelBundle,
  isDir: boolean,
  isArchive: boolean,
): Promise<void> {
  const stagingDir = join(modelDir, ".imports", `${bundle.id}.staging`);
  mkdirSync(stagingDir, { recursive: true });
  try {
    if (isArchive) {
      if (bundle.source.kind !== "tar.bz2") throw new Error(`单文件包 ${bundle.id} 不能从归档导入`);
      // extractArchive 已经过成员预检 + 逐成员解包 + 流式 sha256
      await extractArchive(sourcePath, stagingDir, bundle);
    } else if (isDir) {
      await collectFromDir(sourcePath, stagingDir, bundle);
    } else {
      if (bundle.files.length !== 1) throw new Error(`单文件输入不能导入多文件包 ${bundle.id}`);
      await collectSingleFile(sourcePath, stagingDir, bundle);
    }
    await installBundleFromStaging(modelDir, bundle, stagingDir);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** 目录定位（ADR-0015 §4）：先按完整相对路径，找不到再按 basename+sha256。 */
async function collectFromDir(dir: string, stagingDir: string, bundle: ModelBundle): Promise<void> {
  for (const spec of bundle.files) {
    const direct = join(dir, spec.path);
    if (existsSync(direct) && statSync(direct).isFile()) {
      await verifySha(direct, spec.sha256);
      await copyIntoStaging(direct, stagingDir, spec.path);
      continue;
    }
    // 按 basename 找候选，逐个算 sha256；hash 相同就是同一内容，多个同 hash 不构成歧义
    const wantedBase = spec.path.split("/").pop() ?? spec.path;
    const candidate = await findByHash(dir, wantedBase, spec.sha256);
    if (candidate === undefined) throw new Error(`目录里找不到 ${spec.path}（路径与 sha256 都不匹配）`);
    await copyIntoStaging(candidate, stagingDir, spec.path);
  }
}

async function collectSingleFile(sourcePath: string, stagingDir: string, bundle: ModelBundle): Promise<void> {
  const spec = bundle.files[0];
  if (spec === undefined) throw new Error(`包 ${bundle.id} 没有文件`);
  const stat = statSync(sourcePath);
  if (stat.size !== spec.bytes) throw new Error(`字节数 ${stat.size} 与清单 ${spec.bytes} 不符`);
  await verifySha(sourcePath, spec.sha256);
  await copyIntoStaging(sourcePath, stagingDir, spec.path);
}

async function verifySha(path: string, expectedSha: string): Promise<void> {
  const sha = await streamSha256(path);
  if (sha !== expectedSha) throw new Error(`sha256 不符（期望 ${expectedSha.slice(0, 12)}…，实际 ${sha.slice(0, 12)}…）`);
}

async function findByHash(dir: string, baseName: string, expectedSha: string): Promise<string | undefined> {
  const candidates: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(current, name);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(abs, depth + 1);
      else if (stat.isFile() && name === baseName) candidates.push(abs);
    }
  };
  walk(dir, 0);
  for (const candidate of candidates) {
    if ((await streamSha256(candidate)) === expectedSha) return candidate;
  }
  return undefined;
}

async function copyIntoStaging(source: string, stagingDir: string, relativePath: string): Promise<void> {
  const target = join(stagingDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  await new Promise<void>((resolveCopy, rejectCopy) => {
    const out = createWriteStream(target);
    out.on("error", rejectCopy);
    out.on("finish", () => resolveCopy());
    createReadStream(source).pipe(out);
  });
}

/** staging 里已是清单相对路径；按包原子安装（同 download 的目录交换协议）。 */
async function installBundleFromStaging(modelDir: string, bundle: ModelBundle, stagingDir: string): Promise<void> {
  if (bundle.files.length === 1 && (bundle.files[0]?.path ?? "").indexOf("/") === -1) {
    renameSync(join(stagingDir, bundle.files[0]?.path ?? ""), join(modelDir, bundle.files[0]?.path ?? ""));
    return;
  }
  const suffix = randomUUID();
  const topDirs = [...new Set(bundle.files.map((f) => (f.path.split("/")[0] ?? "")))].filter((d) => d !== "");
  for (const topDir of topDirs) {
    const finalDir = join(modelDir, topDir);
    const newDir = join(modelDir, `${topDir}.new-${suffix}`);
    const oldDir = join(modelDir, `${topDir}.old-${suffix}`);
    mkdirSync(newDir, { recursive: true });
    for (const file of bundle.files.filter((f) => (f.path.split("/")[0] ?? "") === topDir)) {
      renameSync(join(stagingDir, file.path), join(newDir, file.path.slice(topDir.length + 1)));
    }
    if (existsSync(finalDir)) renameSync(finalDir, oldDir);
    renameSync(newDir, finalDir);
    rmSync(oldDir, { recursive: true, force: true });
  }
}
