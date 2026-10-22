import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dataRoot, type EnvRecord } from "./config";

export type StorageMigrationResult = { movedModelDir: boolean; warning: string | null };

/**
 * 旧模型目录迁移（ADR-0020 §2）：仅当 `VNOTE_MODEL_DIR` 未设置、`<数据根>/models`
 * 不存在、`~/.cache/video-notes/models` 存在时，把旧目录 rename 到 `<数据根>/models`。
 * 跨卷（EXDEV）或权限失败不复制、不删除，旧目录保持原样，`modelDir()` 会继续解析到它。
 * 幂等：成功后旧路径消失，再次调用是空操作。
 */
export function migrateStorageLayout(env: EnvRecord = process.env): StorageMigrationResult {
  if (env.VNOTE_MODEL_DIR) return { movedModelDir: false, warning: null };
  const target = `${dataRoot(env)}/models`;
  const legacy = `${env.HOME ?? homedir()}/.cache/video-notes/models`;
  if (existsSync(target) || !existsSync(legacy)) return { movedModelDir: false, warning: null };
  try {
    mkdirSync(`${dataRoot(env)}`, { recursive: true });
    renameSync(legacy, target);
    return { movedModelDir: true, warning: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      movedModelDir: false,
      warning: `旧模型目录 ${legacy} 迁移到 ${target} 失败（${message}）；继续使用旧目录，模型不会丢失，可稍后手动移动`,
    };
  }
}
