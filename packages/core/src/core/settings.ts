import { existsSync, readFileSync, renameSync } from "node:fs";
import { isAbsolute } from "node:path";
import { cacheRoot, asrEnv, envValue, llmEnv, modelDir, notesRoot, type EnvRecord } from "./config";
import { writeJsonAtomic } from "./paths";

export const SETTINGS_VERSION = 2;
export const SETTINGS_FILE_NAME = "settings.json";

export type AsrProvider = "local" | "remote";

/** 磁盘上的原始形状：所有字段可选，缺省不是错误（ADR-0015）。 */
export type SettingsFile = {
  version: 2;
  notesRoot?: string;
  cacheRoot?: string;
  modelDir?: string;
  llm?: { baseUrl?: string; model?: string };
  asr?: {
    provider?: AsrProvider;
    remote?: { baseUrl?: string; model?: string };
    autoDownloadAttemptedAt?: string | null;
  };
};

export type LlmSettings = { baseUrl: string; model: string };
export type AsrSettings = {
  provider: AsrProvider;
  remote: { baseUrl: string; model: string };
  autoDownloadAttemptedAt: string | null;
};
/** 解析后的有效设置：字段齐全。 */
export type AppSettings = {
  version: 2;
  notesRoot: string;
  cacheRoot: string;
  modelDir: string;
  llm: LlmSettings;
  asr: AsrSettings;
};

export type LockedSettings = {
  notesRoot: boolean;
  cacheRoot: boolean;
  modelDir: boolean;
  llmBaseUrl: boolean;
  llmModel: boolean;
  asrProvider: boolean;
  asrBaseUrl: boolean;
  asrModel: boolean;
};

/** 界面 patch：只碰用户可编辑字段，自动下载时间戳走 markAutoDownloadAttempted。 */
export type SettingsPatch = {
  notesRoot?: string;
  cacheRoot?: string;
  modelDir?: string;
  llm?: { baseUrl?: string; model?: string };
  asr?: { provider?: AsrProvider; remote?: { baseUrl?: string; model?: string } };
};

/** 默认值与 config 同口径：路径、llm/asr 全部按 env 求值（ADR-0015）。 */
export function defaultSettings(env: EnvRecord = process.env): AppSettings {
  return resolveSettings({ version: 2 }, env).settings;
}

/**
 * 读文件并严格校验形状（ADR-0015）。缺文件 → `{version: 2}`；
 * 坏 JSON 与坏形状都抛错，错误文案带字段路径与文件路径。
 */
export function readSettingsFile(path: string): SettingsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: SETTINGS_VERSION };
    throw new Error(`设置文件 ${path} 不是合法 JSON`);
  }
  return parseSettingsFile(raw, path);
}

function parseSettingsFile(raw: unknown, path: string): SettingsFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`设置文件 ${path} 的根必须是对象`);
  }
  const root = raw as Record<string, unknown>;
  const version = root.version;
  const isV1 = version === undefined || version === 1;
  if (!isV1 && version !== 2) {
    throw new Error(`设置文件 ${path} 的 version 必须是 1 或 2，实际是 ${JSON.stringify(version)}`);
  }
  const file: SettingsFile = { version: SETTINGS_VERSION };
  for (const key of ["notesRoot", "cacheRoot", "modelDir"] as const) {
    const value = root[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`设置文件 ${path} 的 ${key} 必须是字符串`);
    file[key] = value;
  }
  if (isV1) {
    const unknown = Object.keys(root).filter((key) => key !== "version" && !["notesRoot", "cacheRoot", "modelDir"].includes(key));
    if (unknown.length > 0) throw new Error(`设置文件 ${path} 是 v1 但含未知字段 ${unknown.join("、")}`);
    return file;
  }
  if (root.llm !== undefined) {
    if (typeof root.llm !== "object" || root.llm === null || Array.isArray(root.llm)) {
      throw new Error(`设置文件 ${path} 的 llm 必须是对象`);
    }
    file.llm = objectStrings(root.llm as Record<string, unknown>, path, "llm");
  }
  if (root.asr !== undefined) {
    if (typeof root.asr !== "object" || root.asr === null || Array.isArray(root.asr)) {
      throw new Error(`设置文件 ${path} 的 asr 必须是对象`);
    }
    const asr = root.asr as Record<string, unknown>;
    if (asr.provider !== undefined && asr.provider !== "local" && asr.provider !== "remote") {
      throw new Error(`设置文件 ${path} 的 asr.provider 必须是 local 或 remote，实际是 ${JSON.stringify(asr.provider)}`);
    }
    let remote: { baseUrl?: string; model?: string } | undefined;
    if (asr.remote !== undefined) {
      if (typeof asr.remote !== "object" || asr.remote === null || Array.isArray(asr.remote)) {
        throw new Error(`设置文件 ${path} 的 asr.remote 必须是对象`);
      }
      remote = objectStrings(asr.remote as Record<string, unknown>, path, "asr.remote");
    }
    if (asr.autoDownloadAttemptedAt !== undefined) {
      const value = asr.autoDownloadAttemptedAt;
      if (value !== null && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
        throw new Error(`设置文件 ${path} 的 asr.autoDownloadAttemptedAt 必须是 null 或可解析的 ISO 时间字符串`);
      }
    }
    file.asr = {
      provider: asr.provider === "local" || asr.provider === "remote" ? asr.provider : undefined,
      remote,
      autoDownloadAttemptedAt: asr.autoDownloadAttemptedAt === null ? null : typeof asr.autoDownloadAttemptedAt === "string" ? asr.autoDownloadAttemptedAt : undefined,
    };
  }
  return file;
}

function objectStrings(obj: Record<string, unknown>, path: string, field: string): { baseUrl?: string; model?: string } {
  const out: { baseUrl?: string; model?: string } = {};
  for (const key of ["baseUrl", "model"] as const) {
    const value = obj[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`设置文件 ${path} 的 ${field}.${key} 必须是字符串`);
    out[key] = value;
  }
  return out;
}

/** 文件层的唯一读取入口：读、严格校验、坏文件隔离成 `<path>.bad-<时间戳>` 后按空文件继续（ADR-0015）。 */
export function readSettingsFileSafe(path: string): { file: SettingsFile; error: string | null; quarantinedPath: string | null } {
  try {
    return { file: readSettingsFile(path), error: null, quarantinedPath: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let quarantinedPath: string | null = null;
    if (existsSync(path)) {
      quarantinedPath = `${path}.bad-${new Date().toISOString().replace(/:/g, "-")}`;
      renameSync(path, quarantinedPath);
    }
    return { file: { version: SETTINGS_VERSION }, error: message, quarantinedPath };
  }
}

/** 不读磁盘：文件层 + env 求有效值与 locked（env > 文件 > 默认，ADR-0015）。 */
export function resolveSettings(file: SettingsFile, env: EnvRecord): { settings: AppSettings; locked: LockedSettings } {
  const llmEnvValue = llmEnv(env);
  const asrEnvValue = asrEnv(env);
  const settings: AppSettings = {
    version: SETTINGS_VERSION,
    notesRoot: envValue(env, ["VNOTE_HOME"]) ?? file.notesRoot ?? notesRoot(env),
    cacheRoot: envValue(env, ["VNOTE_CACHE_DIR"]) ?? file.cacheRoot ?? cacheRoot(env),
    modelDir: envValue(env, ["VNOTE_MODEL_DIR"]) ?? file.modelDir ?? modelDir(env),
    llm: {
      baseUrl: llmEnvValue.baseUrl ?? file.llm?.baseUrl?.trim() ?? "",
      model: llmEnvValue.model ?? file.llm?.model?.trim() ?? "",
    },
    asr: {
      provider: (asrEnvValue.provider === "local" || asrEnvValue.provider === "remote" ? asrEnvValue.provider : undefined) ?? file.asr?.provider ?? "local",
      remote: {
        baseUrl: asrEnvValue.baseUrl ?? file.asr?.remote?.baseUrl?.trim() ?? "",
        model: asrEnvValue.model ?? file.asr?.remote?.model?.trim() ?? "",
      },
      autoDownloadAttemptedAt: file.asr?.autoDownloadAttemptedAt ?? null,
    },
  };
  validateSettings(settings);
  return { settings, locked: settingsLockedByEnv(env) };
}

/** 保留旧签名：读文件求有效设置，坏文件抛错（供测试与非桌面调用，ADR-0015）。 */
export function loadSettings(configPath: string, env: EnvRecord = process.env): AppSettings {
  return resolveSettings(readSettingsFile(configPath), env).settings;
}

/** 拒绝被 env 锁定的字段（后端约束，不靠界面 readOnly），再深度合并到文件层并写盘（ADR-0015）。 */
export function saveSettings(configPath: string, patch: SettingsPatch, env: EnvRecord = process.env): AppSettings {
  const locked = settingsLockedByEnv(env);
  rejectLockedPatch(patch, locked);
  const file = readSettingsFile(configPath);
  const merged = mergePatch(file, patch);
  const { settings } = resolveSettings(merged, env);
  writeJsonAtomic(configPath, merged);
  return settings;
}

function rejectLockedPatch(patch: SettingsPatch, locked: LockedSettings): void {
  const rejected: string[] = [];
  if (locked.notesRoot && patch.notesRoot !== undefined) rejected.push("notesRoot");
  if (locked.cacheRoot && patch.cacheRoot !== undefined) rejected.push("cacheRoot");
  if (locked.modelDir && patch.modelDir !== undefined) rejected.push("modelDir");
  if (locked.llmBaseUrl && patch.llm?.baseUrl !== undefined) rejected.push("llm.baseUrl");
  if (locked.llmModel && patch.llm?.model !== undefined) rejected.push("llm.model");
  if (locked.asrProvider && patch.asr?.provider !== undefined) rejected.push("asr.provider");
  if (locked.asrBaseUrl && patch.asr?.remote?.baseUrl !== undefined) rejected.push("asr.remote.baseUrl");
  if (locked.asrModel && patch.asr?.remote?.model !== undefined) rejected.push("asr.remote.model");
  if (rejected.length > 0) {
    throw new Error(`设置 ${rejected.join("、")} 由环境变量控制，请在环境变量里修改`);
  }
}

/** 根、llm、asr、asr.remote 各合并一层，未提供的键保持原值；version 写 2。 */
function mergePatch(file: SettingsFile, patch: SettingsPatch): SettingsFile {
  const merged: SettingsFile = { ...file, llm: file.llm ? { ...file.llm } : undefined, asr: file.asr ? { ...file.asr, remote: file.asr.remote ? { ...file.asr.remote } : undefined } : undefined };
  merged.version = SETTINGS_VERSION;
  for (const key of ["notesRoot", "cacheRoot", "modelDir"] as const) {
    if (patch[key] !== undefined) merged[key] = patch[key];
  }
  if (patch.llm) {
    merged.llm = { ...merged.llm };
    if (patch.llm.baseUrl !== undefined) merged.llm.baseUrl = patch.llm.baseUrl;
    if (patch.llm.model !== undefined) merged.llm.model = patch.llm.model;
  }
  if (patch.asr) {
    merged.asr = { ...merged.asr, remote: merged.asr?.remote ? { ...merged.asr.remote } : undefined };
    if (patch.asr.provider !== undefined) merged.asr.provider = patch.asr.provider;
    if (patch.asr.remote) {
      merged.asr.remote = { ...merged.asr.remote };
      if (patch.asr.remote.baseUrl !== undefined) merged.asr.remote.baseUrl = patch.asr.remote.baseUrl;
      if (patch.asr.remote.model !== undefined) merged.asr.remote.model = patch.asr.remote.model;
    }
  }
  return merged;
}

/** 自动下载时间戳不由用户 patch 写：只深度合并该字段（ADR-0015）。 */
export function markAutoDownloadAttempted(configPath: string, when: string | null, env: EnvRecord = process.env): AppSettings {
  if (when !== null && Number.isNaN(Date.parse(when))) {
    throw new Error(`设置 asr.autoDownloadAttemptedAt 必须是 null 或可解析的 ISO 时间字符串，实际是 ${JSON.stringify(when)}`);
  }
  const file = readSettingsFile(configPath);
  file.asr = { ...file.asr, autoDownloadAttemptedAt: when };
  const { settings } = resolveSettings(file, env);
  writeJsonAtomic(configPath, file);
  return settings;
}

/** 路径非空绝对；baseUrl 为空或是 http(s) 绝对 URL 且不含 userinfo、query、fragment；model 去首尾空白（ADR-0015）。 */
function validateSettings(settings: AppSettings): void {
  for (const field of ["notesRoot", "cacheRoot", "modelDir"] as const) {
    const value = settings[field];
    if (value === "" || !isAbsolute(value)) {
      throw new Error(`设置 ${field} 必须是非空绝对路径，实际是 ${value}`);
    }
  }
  settings.llm.baseUrl = settings.llm.baseUrl.trim();
  settings.llm.model = settings.llm.model.trim();
  settings.asr.remote.baseUrl = settings.asr.remote.baseUrl.trim();
  settings.asr.remote.model = settings.asr.remote.model.trim();
  assertBaseUrl(settings.llm.baseUrl, "llm.baseUrl");
  assertBaseUrl(settings.asr.remote.baseUrl, "asr.remote.baseUrl");
  if (settings.asr.provider !== "local" && settings.asr.provider !== "remote") {
    throw new Error(`设置 asr.provider 必须是 local 或 remote，实际是 ${String(settings.asr.provider)}`);
  }
  const stamp = settings.asr.autoDownloadAttemptedAt;
  if (stamp !== null && Number.isNaN(Date.parse(stamp))) {
    throw new Error(`设置 asr.autoDownloadAttemptedAt 必须是 null 或可解析的 ISO 时间字符串，实际是 ${JSON.stringify(stamp)}`);
  }
}

function assertBaseUrl(value: string, field: string): void {
  if (value === "") return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`设置 ${field} 必须是 http(s) 绝对 URL，实际是 ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`设置 ${field} 必须是 http(s) 绝对 URL，实际是 ${value}`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(`设置 ${field} 不能含凭据、query 或 fragment，实际是 ${value}`);
  }
}

/** 某字段被 env 覆盖时只能改 env，界面上标记为不可改（ADR-0014、ADR-0015）。 */
export function settingsLockedByEnv(env: EnvRecord = process.env): LockedSettings {
  const llm = llmEnv(env);
  const asr = asrEnv(env);
  return {
    notesRoot: envValue(env, ["VNOTE_HOME"]) !== undefined,
    cacheRoot: envValue(env, ["VNOTE_CACHE_DIR"]) !== undefined,
    modelDir: envValue(env, ["VNOTE_MODEL_DIR"]) !== undefined,
    llmBaseUrl: llm.baseUrl !== undefined,
    llmModel: llm.model !== undefined,
    asrProvider: asr.provider !== undefined,
    asrBaseUrl: asr.baseUrl !== undefined,
    asrModel: asr.model !== undefined,
  };
}
