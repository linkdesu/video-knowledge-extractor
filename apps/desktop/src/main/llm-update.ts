import type { SettingsPatch as CoreSettingsPatch } from "@video-notes/core";
import type { LlmUpdatePatch, SecretPatch } from "../shared/ipc";

/**
 * `updateLlm` 的入参 → 一次凭据事务（ADR-0015 §3）：baseUrl/model 只带上行字段，
 * 密钥三态互斥——写新 key / 显式清空 / 不动（输入框留空）。
 * 清空不依赖密钥库可用，因为它只删本地已存值。
 */
export function buildLlmUpdate(patch: LlmUpdatePatch): { settingsPatch: CoreSettingsPatch; secretPatch: SecretPatch } {
  const apiKey = patch.apiKey?.trim();
  if (patch.clearApiKey === true && apiKey !== undefined && apiKey !== "") {
    throw new Error("不能同时保存和清除 API key");
  }
  const llm: { baseUrl?: string; model?: string } = {};
  if (patch.baseUrl !== undefined) llm.baseUrl = patch.baseUrl;
  if (patch.model !== undefined) llm.model = patch.model;
  const secretPatch: SecretPatch =
    patch.clearApiKey === true
      ? { clearApiKey: true }
      : apiKey === undefined || apiKey === ""
        ? {}
        : { apiKey };
  return {
    settingsPatch: Object.keys(llm).length > 0 ? { llm } : {},
    secretPatch,
  };
}
