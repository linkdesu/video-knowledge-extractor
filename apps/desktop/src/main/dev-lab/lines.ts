/**
 * 把一组标签组装成 Lab 字幕行（r48）：复用 core 的 buildSpans → splitSpan → assignSpeakers，
 * 文本由段级解码结果按时间拼接；不复制也不修改正式管线。
 */
import { assignSpeakers, buildSpans, splitSpan } from "@video-notes/core";
import type { DiarizationSegment } from "@video-notes/core";
import type { LabConfigName, LabLine, LabSpeaker } from "../../shared/lab";

export type LabTextRow = { start: number; end: number; text: string };

const MAX_SPAN_SECONDS = 30;

/** 用段级文本拼出 span 文本（按时间顺序，跳过与 span 无交集的段）。 */
function composeText(rows: LabTextRow[], start: number, end: number): string {
  const parts: string[] = [];
  for (const r of rows) {
    if (r.end <= start + 0.02 || r.start >= end - 0.02) continue;
    const t = r.text.trim();
    if (t !== "") parts.push(t);
  }
  return parts.join("");
}

export function assembleLines(input: {
  labels: number[];
  segments: DiarizationSegment[];
  texts: LabTextRow[];
  silences: { start: number; end: number }[];
}): { lines: LabLine[]; speakers: LabSpeaker[] } {
  const labelled = input.segments.map((seg, i) => ({ start: seg.start, end: seg.end, speaker: input.labels[i] ?? 0 }));
  const spans = buildSpans(labelled).flatMap((span) => splitSpan(span, input.silences, MAX_SPAN_SECONDS));
  const assigned = assignSpeakers(spans);
  const lines: LabLine[] = assigned.utterances.map((u) => ({
    start: u.start,
    end: u.end,
    speakerId: u.speakerId,
    text: composeText(input.texts, u.start, u.end),
  }));
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
