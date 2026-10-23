import type { LlmDraft, LlmUpdatePatch } from "../../../shared/ipc";

export type LlmSaved = { baseUrl: string; model: string | null; apiKey: string | null };
export type LlmFormDraft = LlmDraft & { model: string };
export type LlmModelOption = { value: string; label: string };

// r32：已保存的 key 回填进表单（ADR-0024）。输入框里空 key 仍表示「保留已存 key」。
export function draftFrom(saved: LlmSaved): LlmFormDraft {
  return { baseUrl: saved.baseUrl, apiKey: saved.apiKey ?? "", model: saved.model ?? "" };
}

export function llmDirty(saved: LlmSaved, draft: LlmFormDraft): boolean {
  if (draft.baseUrl.trim() !== saved.baseUrl) return true;
  if (draft.model.trim() !== (saved.model ?? "")) return true;
  const apiKey = draft.apiKey.trim();
  return apiKey !== "" && apiKey !== (saved.apiKey ?? "");
}

export function llmPatch(saved: LlmSaved, draft: LlmFormDraft): LlmUpdatePatch | null {
  const baseUrl = draft.baseUrl.trim();
  const model = draft.model.trim();
  const apiKey = draft.apiKey.trim();
  const savedKey = saved.apiKey ?? "";
  const keyChanged = apiKey !== "" && apiKey !== savedKey;
  if (baseUrl === saved.baseUrl && model === (saved.model ?? "") && !keyChanged) return null;
  const patch: LlmUpdatePatch = { baseUrl, model };
  if (keyChanged) patch.apiKey = apiKey;
  return patch;
}

/** 已拉取模型的完整下拉候选：只去重，不按当前值过滤（过滤在组合框打开期间由输入决定）。 */
export function modelOptions(fetched: string[] | null): LlmModelOption[] {
  if (fetched === null) return [];
  const seen = new Set<string>();
  const options: LlmModelOption[] = [];
  for (const id of fetched) {
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({ value: id, label: id });
  }
  return options;
}
