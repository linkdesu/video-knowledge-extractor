import type { LlmDraft, LlmUpdatePatch } from "../../../shared/ipc";

export type LlmSaved = { baseUrl: string; model: string | null };
export type LlmFormDraft = LlmDraft & { model: string };
export type LlmModelOption = { value: string; label: string };

export function draftFrom(saved: LlmSaved): LlmFormDraft {
  return { baseUrl: saved.baseUrl, apiKey: "", model: saved.model ?? "" };
}

export function llmDirty(saved: LlmSaved, draft: LlmFormDraft): boolean {
  if (draft.baseUrl.trim() !== saved.baseUrl) return true;
  if (draft.model.trim() !== (saved.model ?? "")) return true;
  return draft.apiKey.trim() !== "";
}

export function llmPatch(saved: LlmSaved, draft: LlmFormDraft): LlmUpdatePatch | null {
  const baseUrl = draft.baseUrl.trim();
  const model = draft.model.trim();
  const apiKey = draft.apiKey.trim();
  if (baseUrl === saved.baseUrl && model === (saved.model ?? "") && apiKey === "") return null;
  const patch: LlmUpdatePatch = { baseUrl, model };
  if (apiKey !== "") patch.apiKey = apiKey;
  return patch;
}

export function modelOptions(fetched: string[] | null, typed: string): LlmModelOption[] {
  const q = typed.trim().toLowerCase();
  const seen = new Set<string>();
  const options: LlmModelOption[] = [];
  if (fetched === null) return options;
  for (const id of fetched) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (q === "" || id.toLowerCase().includes(q)) options.push({ value: id, label: id });
  }
  return options;
}
