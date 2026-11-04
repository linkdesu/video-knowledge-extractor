/**
 * 把一组标签组装成 Lab 字幕行（r48）：复用 core 的 buildSpans → splitSpan → resolveCrosstalk →
 * assignSpeakers，文本由段级解码结果按时间归属；不复制也不修改正式管线。
 */
import { assignSpeakers, buildSpans, dedupeOverlappingLines, resolveCrosstalk, splitSpan } from "@video-notes/core";
import type { DiarizationSegment } from "@video-notes/core";
import type { LabConfigName, LabLine, LabSpeaker } from "../../shared/lab";

export type LabTextRow = { start: number; end: number; text: string };

const MAX_SPAN_SECONDS = 30;

/**
 * 每段文本只归属一段 span（r70 / #99）：按重叠时长取最多，等量时取起点更贴近文本行的那个。
 * 旧版「与 span 有一点交集就拼进去」会把同一句话复制给重叠的两行，抢话处两行都错。
 */
function ownerOf(rows: LabTextRow[], spans: { start: number; end: number }[]): number[] {
  const margin = 0.02;
  return rows.map((row) => {
    let owner = -1;
    let bestOverlap = 0;
    let bestOffset = Infinity;
    spans.forEach((span, i) => {
      const overlap = Math.min(span.end, row.end) - Math.max(span.start, row.start);
      if (overlap <= margin) return;
      const offset = Math.abs(span.start - row.start);
      const better = overlap > bestOverlap + 1e-9 || (Math.abs(overlap - bestOverlap) <= 1e-9 && offset < bestOffset);
      if (!better) return;
      owner = i;
      bestOverlap = overlap;
      bestOffset = offset;
    });
    return owner;
  });
}

export function assembleLines(input: {
  labels: number[];
  segments: DiarizationSegment[];
  texts: LabTextRow[];
  silences: { start: number; end: number }[];
}): { lines: LabLine[]; speakers: LabSpeaker[] } {
  const labelled = input.segments.map((seg, i) => ({ start: seg.start, end: seg.end, speaker: input.labels[i] ?? 0 }));
  const rawSpans = buildSpans(labelled).flatMap((span) => splitSpan(span, input.silences, MAX_SPAN_SECONDS));
  const spans = resolveCrosstalk(rawSpans);
  const kept = new Set(spans);
  const assigned = assignSpeakers(spans);
  // 文本先按时间贴到原始 span 上；贴到被并入的那个插话段的文本随之丢弃——抢话处的音频已经算在
  // 持话轮者的行里（正式管线解码那段音频同样会带到），再拼一遍就成了复制。
  const textOwner = ownerOf(input.texts, rawSpans);
  const textBySpan = new Map<number, string[]>();
  input.texts.forEach((row, i) => {
    const spanIndex = textOwner[i];
    if (spanIndex === undefined || spanIndex < 0) return;
    const span = rawSpans[spanIndex];
    if (span === undefined || !kept.has(span)) return;
    const text = row.text.trim();
    if (text === "") return;
    const key = spans.indexOf(span);
    const list = textBySpan.get(key) ?? [];
    list.push(text);
    textBySpan.set(key, list);
  });
  // 空文本行直接丢弃（正式管线同样丢弃）：ASR 没解出字的片段若留着，Lab 会多出一条空白行，
  // 摘要的「过滤 N 行」还会把它算成语气词。丢弃后再统计说话人，秒数/行数/样例起点与可见行一致。
  // 最后一步去掉重叠回声造成的重复行（#97）：与正式管线共用 core 的同一条规则。
  const lines: LabLine[] = dedupeOverlappingLines(
    assigned.utterances
      .map((u, i) => ({
        start: u.start,
        end: u.end,
        speakerId: u.speakerId,
        text: (textBySpan.get(i) ?? []).join(""),
      }))
      .filter((line) => line.text.trim() !== ""),
  );
  const totals = new Map<string, { seconds: number; lines: number; starts: { start: number; seconds: number }[] }>();
  for (const line of lines) {
    const entry = totals.get(line.speakerId) ?? { seconds: 0, lines: 0, starts: [] };
    entry.seconds += line.end - line.start;
    entry.lines += 1;
    entry.starts.push({ start: line.start, seconds: line.end - line.start });
    totals.set(line.speakerId, entry);
  }
  const speakers: LabSpeaker[] = assigned.speakers.map((s) => {
    const entry = totals.get(s.id) ?? { seconds: 0, lines: 0, starts: [] };
    return {
      id: s.id,
      seconds: Math.round(entry.seconds * 10) / 10,
      lines: entry.lines,
      sampleStarts: [...entry.starts]
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, 3)
        .map((x) => Math.round(x.start * 100) / 100),
    };
  });
  return { lines, speakers };
}

/** 主播锚点覆盖的簇数：锚点区间里出现的不同标签个数。 */
export function hostClusterCount(anchorRanges: { start: number; end: number }[], segments: DiarizationSegment[], labels: number[]): number | null {
  if (anchorRanges.length === 0) return null;
  const seen = new Set<number>();
  segments.forEach((seg, i) => {
    const hit = anchorRanges.some((r) => seg.start < r.end && seg.end > r.start);
    if (hit) seen.add(labels[i] ?? 0);
  });
  return seen.size === 0 ? null : seen.size;
}

export type { LabConfigName };
