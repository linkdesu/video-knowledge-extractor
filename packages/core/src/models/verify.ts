import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ModelBundle, ModelsStatus } from "./catalog";
import { MODEL_BUNDLES, modelStatus, rememberVerified } from "./catalog";
import { streamSha256 } from "./extract";

/**
 * 全量流式 sha256 校验（ADR-0015 §4）：createReadStream 异步读，不阻塞事件循环，
 * 结果写回进程内缓存，返回状态。设置页「校验模型」显式触发。
 */
export async function verifyModels(
  modelDirArg: string,
  bundles: readonly ModelBundle[] = MODEL_BUNDLES,
): Promise<ModelsStatus> {
  await verifyBundle(modelDirArg, bundles);
  return modelStatus(modelDirArg, bundles);
}

/** 逐文件流式校验并把结果写回缓存；缺失文件标记 verified=false（不阻塞，状态里 present=false）。 */
export async function verifyBundle(
  modelDirArg: string,
  bundles: readonly ModelBundle[],
): Promise<void> {
  const modelDir = resolve(modelDirArg);
  for (const bundle of bundles) {
    for (const spec of bundle.files) {
      const absPath = join(modelDir, spec.path);
      let stat;
      try {
        stat = statSync(absPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const sha = await streamSha256(absPath);
      rememberVerified(absPath, stat.size, stat.mtimeMs, spec.sha256, sha === spec.sha256);
    }
  }
}
