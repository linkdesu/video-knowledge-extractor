export type ComboboxOption = { value: string; label: string };

export const COMBOBOX_EMPTY_HINT = "请先点击“拉取模型”或直接输入模型名";
export const COMBOBOX_NO_MATCH_HINT = "无匹配模型";

/** query 为 null 或空白时返回全部候选，否则按 label 做大小写不敏感子串过滤。 */
export function filterComboboxOptions(
  options: readonly ComboboxOption[],
  query: string | null,
): ComboboxOption[] {
  const q = (query ?? "").trim().toLowerCase();
  if (q === "") return [...options];
  return options.filter((o) => o.label.toLowerCase().includes(q));
}

/** 列表为空时返回给用户的占位提示；有候选但过滤后为空返回无匹配提示；否则 null。 */
export function comboboxEmptyHint(
  options: readonly ComboboxOption[],
  query: string | null,
): string | null {
  if (options.length === 0) return COMBOBOX_EMPTY_HINT;
  return filterComboboxOptions(options, query).length === 0 ? COMBOBOX_NO_MATCH_HINT : null;
}
