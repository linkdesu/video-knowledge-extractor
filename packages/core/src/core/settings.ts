import { existsSync, readFileSync, renameSync } from "node:fs";
import { isAbsolute } from "node:path";
import { cacheRoot, asrEnv, envValue, llmEnv, modelDir, notesRoot, type EnvRecord } from "./config";
import { writeJsonAtomic } from "./paths";

export const SETTINGS_VERSION = 3;
export const SETTINGS_FILE_NAME = "settings.json";

export const ASR_PROVIDERS = ["local", "openai", "volcengine"] as const;
export type AsrProvider = (typeof ASR_PROVIDERS)[number];
export type VolcengineMode = "flash" | "standard";
export type VolcengineAuthMode = "apiKey" | "appAccessKey";

/** 磁盘上的原始形状：所有字段可选，缺省不是错误（ADR-0015、ADR-0016）。 */
export type SettingsFile = {
  version: 3;
  notesRoot?: string;
  cacheRoot?: string;
  modelDir?: string;
  llm?: { baseUrl?: string; model?: string };
  asr?: {
    provider?: AsrProvider;
    openai?: { baseUrl?: string; model?: string };
    volcengine?: { mode?: VolcengineMode; authMode?: VolcengineAuthMode };
    autoDownloadAttemptedAt?: string | null;
  };
};

export type LlmSettings = { baseUrl: string; model: string };
export type AsrSettings = {
  provider: AsrProvider;
  openai: { baseUrl: string; model: string };
  volcengine: { mode: VolcengineMode; authMode: VolcengineAuthMode };
  autoDownloadAttemptedAt: string | null;
};
/** 解析后的有效设置：字段齐全。 */
export type AppSettings = {
  version: 3;
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
  volcMode: boolean;
  volcAuthMode: boolean;
};

/** 界面 patch：只碰用户可编辑字段，自动下载时间戳走 markAutoDownloadAttempted。 */
export type SettingsPatch = {
  notesRoot?: string;
  cacheRoot?: string;
  modelDir?: string;
  llm?: { baseUrl?: string; model?: string };
  asr?: {
    provider?: AsrProvider;
    openai?: { baseUrl?: string; model?: string };
    volcengine?: { mode?: VolcengineMode; authMode?: VolcengineAuthMode };
  };
};

/** 默认值与 config 同口径：路径、llm/asr 全部按 env 求值（ADR-0015、ADR-0016）。 */
export function defaultSettings(env: EnvRecord = process.env): AppSettings {
  return resolveSettings({ version: SETTINGS_VERSION }, env).settings;
}

/**
 * 读文件并严格校验形状（ADR-0015、ADR-0016）。缺文件 → `{version: 3}`；
 * v1 / v2 只在内存里迁移成 v3，坏文件才抛错，错误文案带字段路径与文件路径。
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettingsFile(raw: unknown, path: string): SettingsFile {
  if (!isPlainObject(raw)) {
    throw new Error(`设置文件 ${path} 的根必须是对象`);
  }
  const root = raw;
  const version = root.version;
  const isV1 = version === undefined || version === 1;
  if (!isV1 && version !== 2 && version !== 3) {
    throw new Error(`设置文件 ${path} 的 version 必须是 1、2 或 3，实际是 ${JSON.stringify(version)}`);
  }
  const file: SettingsFile = { version: SETTINGS_VERSION };
  for (const key of ["notesRoot", "cacheRoot", "modelDir"] as const) {
    const value = root[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`设置文件 ${path} 的 ${key} 必须是字符串`);
    file[key] = value;
  }
  if (isV1) {
    // v1 只允许路径字段（ADR-0015），再补 v3 默认值（ADR-0016 §2）。
    const unknown = Object.keys(root).filter((key) => key !== "version" && !["notesRoot", "cacheRoot", "modelDir"].includes(key));
    if (unknown.length > 0) throw new Error(`设置文件 ${path} 是 v1 但含未知字段 ${unknown.join("、")}`);
    return file;
  }
  if (root.llm !== undefined) {
    if (!isPlainObject(root.llm)) throw new Error(`设置文件 ${path} 的 llm 必须是对象`);
    file.llm = objectStrings(root.llm, path, "llm");
  }
  if (root.asr !== undefined) {
    if (!isPlainObject(root.asr)) throw new Error(`设置文件 ${path} 的 asr 必须是对象`);
    const asr = root.asr;
    const fileAsr: NonNullable<SettingsFile["asr"]> = {};
    if (version === 2) {
      // ADR-0016 §2：v2 的 "remote" 只在迁移入口被接受，运行时值是 openai。
      if (asr.provider === undefined) fileAsr.provider = undefined;
      else if (asr.provider === "local") fileAsr.provider = "local";
      else if (asr.provider === "remote") fileAsr.provider = "openai";
      else throw new Error(`设置文件 ${path} 的 asr.provider 必须是 local 或 remote，实际是 ${JSON.stringify(asr.provider)}`);
    } else if (asr.provider !== undefined) {
      if (asr.provider === "local" || asr.provider === "openai" || asr.provider === "volcengine") fileAsr.provider = asr.provider;
      else throw new Error(`设置文件 ${path} 的 asr.provider 必须是 local、openai 或 volcengine，实际是 ${JSON.stringify(asr.provider)}`);
    }
    // 已存在的块始终做形状校验，即使未选中（ADR-0016 §2）。
    // v2 文件 asr.remote → asr.openai；两者并存时以 openai 为准、忽略 remote，但 remote 仍校验。
    let remoteStrings: { baseUrl?: string; model?: string } | undefined;
    if (asr.remote !== undefined) {
      if (!isPlainObject(asr.remote)) throw new Error(`设置文件 ${path} 的 asr.remote 必须是对象`);
      remoteStrings = objectStrings(asr.remote, path, "asr.remote");
    }
    if (asr.openai !== undefined) {
      if (!isPlainObject(asr.openai)) throw new Error(`设置文件 ${path} 的 asr.openai 必须是对象`);
      fileAsr.openai = objectStrings(asr.openai, path, "asr.openai");
    } else if (remoteStrings !== undefined) {
      fileAsr.openai = remoteStrings;
    }
    if (asr.volcengine !== undefined) {
      if (!isPlainObject(asr.volcengine)) throw new Error(`设置文件 ${path} 的 asr.volcengine 必须是对象`);
      const vc = asr.volcengine;
      if (vc.mode !== undefined && vc.mode !== "flash" && vc.mode !== "standard") {
        throw new Error(`设置文件 ${path} 的 asr.volcengine.mode 必须是 flash 或 standard，实际是 ${JSON.stringify(vc.mode)}`);
      }
      if (vc.authMode !== undefined && vc.authMode !== "apiKey" && vc.authMode !== "appAccessKey") {
        throw new Error(`设置文件 ${path} 的 asr.volcengine.authMode 必须是 apiKey 或 appAccessKey，实际是 ${JSON.stringify(vc.authMode)}`);
      }
      fileAsr.volcengine = {
        mode: vc.mode === "flash" || vc.mode === "standard" ? vc.mode : undefined,
        authMode: vc.authMode === "apiKey" || vc.authMode === "appAccessKey" ? vc.authMode : undefined,
      };
    }
    if (asr.autoDownloadAttemptedAt !== undefined) {
      const value = asr.autoDownloadAttemptedAt;
      if (value !== null && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
        throw new Error(`设置文件 ${path} 的 asr.autoDownloadAttemptedAt 必须是 null 或可解析的 ISO 时间字符串`);
      }
    }
    fileAsr.autoDownloadAttemptedAt = asr.autoDownloadAttemptedAt === null ? null : typeof asr.autoDownloadAttemptedAt === "string" ? asr.autoDownloadAttemptedAt : undefined;
    file.asr = fileAsr;
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

/** 不读磁盘：文件层 + env 求有效值与 locked（env > 文件 > 默认，ADR-0015、ADR-0016）。 */
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
      provider:
        (asrEnvValue.provider === "local" || asrEnvValue.provider === "openai" || asrEnvValue.provider === "volcengine"
          ? asrEnvValue.provider
          : undefined) ?? file.asr?.provider ?? "local",
      openai: {
        baseUrl: asrEnvValue.baseUrl ?? file.asr?.openai?.baseUrl?.trim() ?? "",
        model: asrEnvValue.model ?? file.asr?.openai?.model?.trim() ?? "",
      },
      volcengine: {
        mode:
          asrEnvValue.volcMode === "flash" || asrEnvValue.volcMode === "standard"
            ? asrEnvValue.volcMode
            : file.asr?.volcengine?.mode ?? "flash",
        authMode:
          asrEnvValue.volcAuthMode === "apiKey" || asrEnvValue.volcAuthMode === "appAccessKey"
            ? asrEnvValue.volcAuthMode
            : file.asr?.volcengine?.authMode ?? "apiKey",
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
  if (locked.asrBaseUrl && patch.asr?.openai?.baseUrl !== undefined) rejected.push("asr.openai.baseUrl");
  if (locked.asrModel && patch.asr?.openai?.model !== undefined) rejected.push("asr.openai.model");
  if (locked.volcMode && patch.asr?.volcengine?.mode !== undefined) rejected.push("asr.volcengine.mode");
  if (locked.volcAuthMode && patch.asr?.volcengine?.authMode !== undefined) rejected.push("asr.volcengine.authMode");
  if (rejected.length > 0) {
    throw new Error(`设置 ${rejected.join("、")} 由环境变量控制，请在环境变量里修改`);
  }
}

/** 根、llm、asr、asr.openai、asr.volcengine 各合并一层，未提供的键保持原值；version 写 3。 */
function mergePatch(file: SettingsFile, patch: SettingsPatch): SettingsFile {
  const merged: SettingsFile = {
    ...file,
    llm: file.llm ? { ...file.llm } : undefined,
    asr: file.asr
      ? { ...file.asr, openai: file.asr.openai ? { ...file.asr.openai } : undefined, volcengine: file.asr.volcengine ? { ...file.asr.volcengine } : undefined }
      : undefined,
  };
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
    merged.asr = {
      ...merged.asr,
      openai: merged.asr?.openai ? { ...merged.asr.openai } : undefined,
      volcengine: merged.asr?.volcengine ? { ...merged.asr.volcengine } : undefined,
    };
    if (patch.asr.provider !== undefined) merged.asr.provider = patch.asr.provider;
    if (patch.asr.openai) {
      merged.asr.openai = { ...merged.asr.openai };
      if (patch.asr.openai.baseUrl !== undefined) merged.asr.openai.baseUrl = patch.asr.openai.baseUrl;
      if (patch.asr.openai.model !== undefined) merged.asr.openai.model = patch.asr.openai.model;
    }
    if (patch.asr.volcengine) {
      merged.asr.volcengine = { ...merged.asr.volcengine };
      if (patch.asr.volcengine.mode !== undefined) merged.asr.volcengine.mode = patch.asr.volcengine.mode;
      if (patch.asr.volcengine.authMode !== undefined) merged.asr.volcengine.authMode = patch.asr.volcengine.authMode;
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

/**
 * 所有已存在的块始终执行形状、枚举与 URL 安全校验（openai.baseUrl 即使未选中也不允许
 * userinfo/query/fragment）；完整性检查在凭据解析层按选中块做（ADR-0016 §2、§4）。
 * 路径非空绝对；baseUrl 为空或是 http(s) 绝对 URL 且不含 userinfo、query、fragment；model 去首尾空白。
 */
function validateSettings(settings: AppSettings): void {
  for (const field of ["notesRoot", "cacheRoot", "modelDir"] as const) {
    const value = settings[field];
    if (value === "" || !isAbsolute(value)) {
      throw new Error(`设置 ${field} 必须是非空绝对路径，实际是 ${value}`);
    }
  }
  settings.llm.baseUrl = settings.llm.baseUrl.trim();
  settings.llm.model = settings.llm.model.trim();
  settings.asr.openai.baseUrl = settings.asr.openai.baseUrl.trim();
  settings.asr.openai.model = settings.asr.openai.model.trim();
  assertBaseUrl(settings.llm.baseUrl, "llm.baseUrl");
  assertBaseUrl(settings.asr.openai.baseUrl, "asr.openai.baseUrl");
  if (settings.asr.provider !== "local" && settings.asr.provider !== "openai" && settings.asr.provider !== "volcengine") {
    throw new Error(`设置 asr.provider 必须是 local、openai 或 volcengine，实际是 ${String(settings.asr.provider)}`);
  }
  if (settings.asr.volcengine.mode !== "flash" && settings.asr.volcengine.mode !== "standard") {
    throw new Error(`设置 asr.volcengine.mode 必须是 flash 或 standard，实际是 ${String(settings.asr.volcengine.mode)}`);
  }
  if (settings.asr.volcengine.authMode !== "apiKey" && settings.asr.volcengine.authMode !== "appAccessKey") {
    throw new Error(`设置 asr.volcengine.authMode 必须是 apiKey 或 appAccessKey，实际是 ${String(settings.asr.volcengine.authMode)}`);
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

/** 某字段被 env 覆盖时只能改 env，界面上标记为不可改（ADR-0014、ADR-0015、ADR-0016）。 */
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
    volcMode: asr.volcMode !== undefined,
    volcAuthMode: asr.volcAuthMode !== undefined,
  };
}
