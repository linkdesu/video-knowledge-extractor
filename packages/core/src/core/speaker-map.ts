import type { Speaker } from "./types";

/** 解析输入的形状：不依赖品牌类型，`id` 按 string 比较。 */
type SpeakerRef = Pick<Speaker, "name"> & { id: string; mergedInto?: string | null };

/**
 * 说话人名解析（r35 合并）：`mergedInto` 链指向最终存活者，正文与界面都显示存活者的名字；
 * 环或指向不存在的 id 时回退到自身。
 */
export function resolveSpeaker(speakers: ReadonlyArray<SpeakerRef>, id: string): { id: string; name: string } {
  let cur = id;
  const seen = new Set<string>([id]);
  while (true) {
    const s = speakers.find((x) => x.id === cur);
    if (s === undefined) break;
    const next = s.mergedInto ?? null;
    if (next === null || next === undefined) break;
    if (seen.has(next)) break;
    seen.add(next);
    cur = next;
  }
  const target = speakers.find((x) => x.id === cur);
  return { id: cur, name: target?.name ?? cur };
}

/** 说话人 id → 存活者名字的映射，渲染 `topic.md` 与界面共用这一份解析。 */
export function speakerNameMap(speakers: ReadonlyArray<SpeakerRef>): Map<string, string> {
  return new Map(speakers.map((s) => [s.id, resolveSpeaker(speakers, s.id).name]));
}

/** 主播名单（r47）：解析成存活者名字，按传入顺序去重；解析不到或已合并掉的 id 丢弃。 */
export function hostNames(speakers: ReadonlyArray<SpeakerRef>, hosts: ReadonlyArray<string> | undefined): string[] {
  if (hosts === undefined || hosts.length === 0) return [];
  const top = new Set(speakers.filter((s) => (s.mergedInto ?? null) === null).map((s) => s.id));
  const names: string[] = [];
  for (const id of hosts) {
    if (!top.has(id)) continue;
    const name = resolveSpeaker(speakers, id).name;
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
}
