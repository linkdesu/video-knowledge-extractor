/**
 * verify 私有 LLM 配置：读取、校验、写入隔离实例的 userData。
 *
 * 私有文件刻意放在仓库外，且只允许当前用户读写：
 *   mac      ~/.config/video-notes-verify/llm.json
 *   windows  %USERPROFILE%\.config\video-notes-verify\llm.json
 *
 * 仓库里只有不含真实值的模板 `.omp/skills/verify-video-notes/config/llm.example.json`。
 * 本模块是纯逻辑（文件 IO 只用于读写），权限/位置检查由调用方把真实路径传进来。
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/** 应用设置文档版本（与 packages/core/src/core/settings.ts 的 SETTINGS_VERSION 一致）。 */
export const SETTINGS_VERSION = 3;
/** 密钥文件版本（与 apps/desktop/src/main/secrets.ts 的 v2 一致）。 */
export const SECRETS_VERSION = 2;

export type LlmPrivateConfig = {
  baseUrl: string;
  apiKey: string;
  model: string | null;
};

export type SeedTarget = {
  /** 本次运行的隔离 userData 目录。 */
  userData: string;
};

const PLACEHOLDER_PATTERNS = [/^<.*>$/, /your-|example\.com|placeholder|填入/i];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析并校验私有配置；错误文案指出字段与修复动作，绝不回显值。 */
export function parsePrivateConfig(raw: unknown): LlmPrivateConfig {
  if (!isPlainObject(raw)) throw new Error("私有配置的根必须是 JSON 对象");
  const baseUrl = raw.baseUrl;
  const apiKey = raw.apiKey;
  const model = raw.model;
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") throw new Error("私有配置缺少非空字符串 baseUrl");
  if (typeof apiKey !== "string" || apiKey.trim() === "") throw new Error("私有配置缺少非空字符串 apiKey");
  if (model !== undefined && model !== null && typeof model !== "string") throw new Error("私有配置的 model 必须是字符串或缺省");
  const trimmedUrl = baseUrl.trim();
  if (!/^https?:\/\//i.test(trimmedUrl)) throw new Error("私有配置的 baseUrl 必须以 http:// 或 https:// 开头");
  if (PLACEHOLDER_PATTERNS.some((p) => p.test(trimmedUrl))) throw new Error("私有配置的 baseUrl 仍是模板值");
  if (PLACEHOLDER_PATTERNS.some((p) => p.test(apiKey.trim()))) throw new Error("私有配置的 apiKey 仍是模板值");
  return {
    baseUrl: trimmedUrl,
    apiKey: apiKey.trim(),
    model: typeof model === "string" && model.trim() !== "" ? model.trim() : null,
  };
}

/** 读私有文件；不存在或不可读时给出模板路径与三步修复命令（不含任何真实值）。 */
export function loadPrivateConfig(path: string, opts: { repoRoot: string; examplePath: string }): LlmPrivateConfig {
  const abs = resolve(path);
  const repo = resolve(opts.repoRoot);
  if (abs === repo || abs.startsWith(`${repo}${sep}`)) {
    throw new Error(`私有配置必须放在仓库外：${abs}`);
  }
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        [
          `缺少私有 LLM 配置：${abs}`,
          `  1) cp "${opts.examplePath}" "${abs}"`,
          `  2) 填入真实 baseUrl / apiKey / model（也可以先跑 export-private-config 从已安装应用导出）`,
          `  3) chmod 600 "${abs}"`,
        ].join("\n"),
      );
    }
    throw new Error(`私有 LLM 配置读取失败：${abs}（${code ?? String(err)}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`私有 LLM 配置不是合法 JSON：${abs}`);
  }
  return parsePrivateConfig(parsed);
}

export type SettingsFileLike = Record<string, unknown>;

/** 生成 settings.json：保留既有键，只覆盖 version 与 llm.baseUrl/model。 */
export function buildSettingsJson(existingRaw: string | null, cfg: LlmPrivateConfig): string {
  let existing: SettingsFileLike = {};
  if (existingRaw !== null && existingRaw.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(existingRaw);
      if (isPlainObject(parsed)) existing = parsed;
    } catch {
      // 坏文件按空处理：seed 的目标是让实例可用，不在这里重新定义设置文件的校验
    }
  }
  const existingLlm = isPlainObject(existing.llm) ? existing.llm : {};
  const llm: Record<string, unknown> = { ...existingLlm, baseUrl: cfg.baseUrl };
  if (cfg.model !== null) llm.model = cfg.model;
  return `${JSON.stringify({ ...existing, version: SETTINGS_VERSION, llm }, null, 2)}\n`;
}

/** 生成 secrets.bin：保留既有密钥位，只覆盖 llm。 */
export function buildSecretsJson(existingRaw: string | null, cfg: LlmPrivateConfig): string {
  let existing: SettingsFileLike = {};
  if (existingRaw !== null && existingRaw.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(existingRaw);
      if (isPlainObject(parsed)) existing = parsed;
    } catch {
      // 坏文件按空处理
    }
  }
  return `${JSON.stringify({ ...existing, version: SECRETS_VERSION, llm: cfg.apiKey }, null, 2)}\n`;
}

export type SeedResult = { settingsPath: string; secretsPath: string };

/**
 * 把私有配置写进一个 userData 目录（隔离实例启动前调用）。
 * secrets.bin 用 0600；已存在的其他设置/密钥位保留。
 */
export function seedUserData(userData: string, cfg: LlmPrivateConfig): SeedResult {
  const settingsPath = resolve(userData, "settings.json");
  const secretsPath = resolve(userData, "secrets.bin");
  mkdirSync(dirname(settingsPath), { recursive: true });
  const readOrNull = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  writeFileSync(settingsPath, buildSettingsJson(readOrNull(settingsPath), cfg), { mode: 0o600 });
  writeFileSync(secretsPath, buildSecretsJson(readOrNull(secretsPath), cfg), { mode: 0o600 });
  try {
    chmodSync(settingsPath, 0o600);
    chmodSync(secretsPath, 0o600);
  } catch {
    // 不支持位权限的文件系统：创建时的 0600 已足够
  }
  return { settingsPath, secretsPath };
}

/** 从应用真实 userData 的文件内容提取私有配置（只用于首次导出，不打印值）。 */
export function extractPrivateConfig(settingsRaw: string, secretsRaw: string | null): LlmPrivateConfig {
  let settings: unknown;
  try {
    settings = JSON.parse(settingsRaw);
  } catch {
    throw new Error("已安装应用的 settings.json 不是合法 JSON，无法导出");
  }
  if (!isPlainObject(settings)) throw new Error("已安装应用的 settings.json 不是对象，无法导出");
  const llm = isPlainObject(settings.llm) ? settings.llm : {};
  const baseUrl = typeof llm.baseUrl === "string" ? llm.baseUrl : "";
  const model = typeof llm.model === "string" ? llm.model : null;
  if (secretsRaw === null) throw new Error("已安装应用没有 secrets.bin，无法导出 API key");
  let secrets: unknown;
  try {
    secrets = JSON.parse(secretsRaw);
  } catch {
    throw new Error("已安装应用的 secrets.bin 不是合法的本地密钥文件（可能是旧版系统加密格式），无法导出");
  }
  if (!isPlainObject(secrets)) throw new Error("已安装应用的 secrets.bin 不是对象，无法导出");
  const apiKey = typeof secrets.llm === "string" ? secrets.llm : "";
  return parsePrivateConfig({ baseUrl, apiKey, model });
}

/** 写私有配置文件（0600），父目录不存在时创建；返回绝对路径。 */
export function writePrivateConfig(path: string, cfg: LlmPrivateConfig): string {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, ...(cfg.model === null ? {} : { model: cfg.model }) }, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(abs, 0o600);
  } catch {
    // 同上
  }
  return abs;
}

/** 权限必须恰好 0600（其他位一律拒绝，避免 key 被同机其他用户读到）。 */
export function assertPrivateMode(mode: number, path: string): void {
  const bits = mode & 0o777;
  if (bits !== 0o600) {
    throw new Error(`私有 LLM 配置权限必须是 0600，实际是 0${bits.toString(8)}：chmod 600 "${path}"`);
  }
}
