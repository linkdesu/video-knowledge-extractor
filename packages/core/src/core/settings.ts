import { isAbsolute } from "node:path";
import { cacheRoot, modelDir, notesRoot, type EnvRecord } from "./config";
import { readJsonFile, writeJsonAtomic } from "./paths";

/** 应用设置：只存三个路径，不存 API key 或 LLM 端点（ADR-0009、ADR-0014）。 */
export type AppSettings = {
  notesRoot: string;
  cacheRoot: string;
  modelDir: string;
};

export const SETTINGS_FILE_NAME = "settings.json";

/** 默认值与 config 同口径：三个路径都按 env 求值。 */
export function defaultSettings(env: EnvRecord = process.env): AppSettings {
  return {
    notesRoot: notesRoot(env),
    cacheRoot: cacheRoot(env),
    modelDir: modelDir(env),
  };
}

/** 优先级 env > settings.json > 默认；缺文件是合法的，坏文件抛错。 */
export function loadSettings(configPath: string, env: EnvRecord = process.env): AppSettings {
  const file = readJsonFile<Partial<Record<keyof AppSettings, string>>>(configPath);
  const settings: AppSettings = { ...defaultSettings(env), ...(file ?? {}) };
  if (env.VNOTE_HOME) settings.notesRoot = env.VNOTE_HOME;
  if (env.VNOTE_CACHE_DIR) settings.cacheRoot = env.VNOTE_CACHE_DIR;
  if (env.VNOTE_MODEL_DIR) settings.modelDir = env.VNOTE_MODEL_DIR;
  validateSettings(settings);
  return settings;
}

/** patch 合并进已加载设置后原子写盘；返回合并后的完整设置。 */
export function saveSettings(configPath: string, patch: Partial<AppSettings>, env: EnvRecord = process.env): AppSettings {
  const merged: AppSettings = { ...loadSettings(configPath, env), ...patch };
  validateSettings(merged);
  writeJsonAtomic(configPath, merged);
  return merged;
}

/** 只接受非空绝对路径；相对路径或空串按字段名报错。 */
function validateSettings(settings: AppSettings): void {
  for (const field of Object.keys(settings) as (keyof AppSettings)[]) {
    const value = settings[field];
    if (typeof value !== "string" || value === "" || !isAbsolute(value)) {
      throw new Error(`设置 ${field} 必须是非空绝对路径，实际是 ${value}`);
    }
  }
}

/** 桌面端设置页用：某字段被 env 覆盖时只能改 env，界面上标记为不可改（ADR-0014）。 */
export function settingsLockedByEnv(env: EnvRecord = process.env): { notesRoot: boolean; cacheRoot: boolean; modelDir: boolean } {
  return {
    notesRoot: env.VNOTE_HOME !== undefined && env.VNOTE_HOME !== "",
    cacheRoot: env.VNOTE_CACHE_DIR !== undefined && env.VNOTE_CACHE_DIR !== "",
    modelDir: env.VNOTE_MODEL_DIR !== undefined && env.VNOTE_MODEL_DIR !== "",
  };
}
