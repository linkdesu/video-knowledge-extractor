import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 升级前后 LLM 配置指纹（r45c）：只回“是否配齐 + 模型名”，baseUrl 与 API key 绝不外带。
 * 读的是应用真实存储格式：`<userData>/settings.json` 的 `llm.baseUrl` + `<userData>/secrets.bin` 的 `llm`。
 */
export type LlmConfigFingerprint = {
  /** baseUrl 与 key 都在才算配齐（模型可留空，走自动发现）。 */
  configured: boolean;
  model: string | null;
};

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function nested(record: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  if (record === null) return null;
  const value = record[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readLlmConfigFingerprint(userDataDir: string): LlmConfigFingerprint {
  const settings = readJsonObject(join(userDataDir, "settings.json"));
  const secrets = readJsonObject(join(userDataDir, "secrets.bin"));
  const llm = nested(settings, "llm");
  const baseUrl = typeof llm?.baseUrl === "string" ? llm.baseUrl.trim() : "";
  const model = typeof llm?.model === "string" && llm.model.trim() !== "" ? llm.model.trim() : null;
  const key = typeof secrets?.llm === "string" ? secrets.llm : "";
  return { configured: baseUrl !== "" && key !== "", model };
}

/**
 * 升级不许把已配齐的 LLM 配置弄丢：升级前 configured=true 而升级后不是，直接失败。
 * 升级前本来就没配置（新机器/旧版未填）时跳过，返回是否需要人工确认。
 */
export function assertLlmConfigPreserved(
  before: LlmConfigFingerprint,
  after: LlmConfigFingerprint,
  platform: string,
): { checked: boolean; modelChanged: boolean } {
  if (!before.configured) return { checked: false, modelChanged: false };
  if (!after.configured) {
    throw new Error(
      `${platform} 升级后 LLM 配置丢失（升级前 baseUrl+key 齐全，升级后不齐）。` +
        "不要删除或改名 userData；请检查安装程序是否清除了 %APPDATA%\\Video Notes / ~/Library/Application Support/Video Notes。",
    );
  }
  return { checked: true, modelChanged: before.model !== after.model };
}
