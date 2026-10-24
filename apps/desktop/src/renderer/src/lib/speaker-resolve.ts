import type { SpeakerInfo } from "../../../shared/ipc";

/**
 * 说话人名解析（r35 合并）：`mergedInto` 链指向最终存活者，字幕与笔记显示存活者的名字与颜色；
 * 环或指向不存在的 id 时回退到自身（与 core 的 `resolveSpeaker` 同一口径）。
 */
export function resolveSpeakerName(speakers: SpeakerInfo[], id: string): { name: string; color: string } {
  let cur = id;
  const seen = new Set<string>([id]);
  while (true) {
    const s = speakers.find((x) => x.id === cur);
    if (s === undefined) break;
    if (s.mergedInto === null) break;
    if (seen.has(s.mergedInto)) break;
    seen.add(s.mergedInto);
    cur = s.mergedInto;
  }
  const target = speakers.find((x) => x.id === cur);
  if (target !== undefined) return { name: target.name, color: target.color };
  return { name: id, color: "#9aa3b8" };
}
