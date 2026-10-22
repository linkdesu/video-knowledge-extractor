export type LlmSaved = { baseUrl: string; model: string | null };
export type LlmDraft = { baseUrl: string; model: string };
export type LlmSavePatch = { baseUrl?: string; model?: string };
export type LlmLocked = { baseUrl: boolean; model: boolean };
export type LlmModelOption = { value: string; label: string };

export function draftFrom(saved: LlmSaved): LlmDraft {
  return { baseUrl: saved.baseUrl, model: saved.model ?? "" };
}

export function llmDirty(saved: LlmSaved, draft: LlmDraft, locked: LlmLocked): boolean {
  if (!locked.baseUrl && draft.baseUrl.trim() !== saved.baseUrl) return true;
  if (!locked.model && draft.model.trim() !== (saved.model ?? "")) return true;
  return false;
}

export function llmBaseUrlChanged(saved: LlmSaved, draft: LlmDraft, locked: LlmLocked): boolean {
  if (!locked.baseUrl && draft.baseUrl.trim() !== saved.baseUrl) return true;
  return false;
}

export function llmPatch(
  saved: LlmSaved,
  draft: LlmDraft,
  locked: LlmLocked,
): LlmSavePatch | null {
  const patch: LlmSavePatch = {};
  if (!locked.baseUrl && draft.baseUrl.trim() !== saved.baseUrl) {
    patch.baseUrl = draft.baseUrl.trim();
  }
  if (!locked.model) {
    const next = draft.model.trim();
    const prev = saved.model ?? "";
    if (next !== prev) patch.model = next;
  }
  if (Object.keys(patch).length === 0) return null;
  return patch;
}

export function modelOptions(
  fetched: string[] | null,
  selected: string,
): LlmModelOption[] {
  const options: LlmModelOption[] = [{ value: "", label: "自动发现（留空）" }];
  if (fetched !== null) {
    const seen = new Set<string>([""]);
    for (const name of fetched) {
      if (seen.has(name)) continue;
      seen.add(name);
      options.push({ value: name, label: name });
    }
  }
  if (selected !== "" && !options.some((o) => o.value === selected)) {
    options.push({ value: selected, label: selected });
  }
  return options;
}
