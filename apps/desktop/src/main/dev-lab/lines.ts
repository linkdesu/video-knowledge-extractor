/**
 * 把一组标签组装成 Lab 字幕行（r48）：复用 core 的 buildSpans → splitSpan → assignSpeakers，
 * 文本由段级解码结果按时间拼接；不复制也不修改正式管线。
 */
import { assignSpeakers, buildSpans, splitSpan } from "@video-notes/core";
import type { DiarizationSegment } from "@video-notes/core";
import type { LabConfigName, LabLine, LabSpeaker } from "../../shared/lab";

export type LabTextRow = { start: number; end: number; text: string };

const MAX_SPAN_SECONDS = 30;

/** 重叠判定的容差：只擦过边界的文本行不算与这一行有交集（吸收 diarization 的边界抖动）。 */
const OWNER_MARGIN = 0.02;

/**
 * 每段文本只归属一行（#97）：判重只用两种证据，文字像不像不参与。
 * - 时间：取重叠秒数最多的那一行；重叠不超过 `OWNER_MARGIN` 的行没有资格。
 * - 说话人：重叠等长时（一段文本被两行完整覆盖，抢话处常见）回它自己的说话人那行；
 *   说话人未知时退到起点更贴近文本行的那一行。
 * 旧口径「有一点时间交集就拼进来」会把同一句话拼进两行——听声音是两句不同的话，看起来却重复。
 */
function textOwners(
  rows: LabTextRow[],
  lines: { start: number; end: number; speakerId: string }[],
  rowSpeakers: (string | undefined)[],
): number[] {
  return rows.map((row, r) => {
    let owner = -1;
    let bestOverlap = 0;
    let bestSpeaker = false;
    let bestOffset = Infinity;
    lines.forEach((line, i) => {
      const overlap = Math.min(line.end, row.end) - Math.max(line.start, row.start);
      if (overlap <= OWNER_MARGIN) return;
      const sameSpeaker = rowSpeakers[r] !== undefined && rowSpeakers[r] === line.speakerId;
      const offset = Math.abs(line.start - row.start);
      const better =
        overlap > bestOverlap + 1e-9 ||
        (Math.abs(overlap - bestOverlap) <= 1e-9 &&
          (sameSpeaker !== bestSpeaker ? sameSpeaker : sameSpeaker && offset < bestOffset));
      if (!better) return;
      owner = i;
      bestOverlap = overlap;
      bestSpeaker = sameSpeaker;
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
  const spans = buildSpans(labelled).flatMap((span) => splitSpan(span, input.silences, MAX_SPAN_SECONDS));
  const assigned = assignSpeakers(spans);
  // 文本行与分离段一一对应（segtext.rows 由 worker 按 segments 顺序写出），以此取得「这段文本是谁说的」。
  const labelToSpeaker = new Map<number, string>();
  spans.forEach((span, i) => {
    const utterance = assigned.utterances[i];
    if (utterance !== undefined) labelToSpeaker.set(span.speaker, utterance.speakerId);
  });
  const rowSpeakers =
    input.texts.length === input.segments.length
      ? input.segments.map((seg) => labelToSpeaker.get(seg.speaker))
      : [];
  const owners = textOwners(input.texts, assigned.utterances, rowSpeakers);
  const textsByLine = new Map<number, string[]>();
  input.texts.forEach((row, i) => {
    const owner = owners[i];
    const text = row.text.trim();
    if (owner === undefined || owner < 0 || text === "") return;
    const list = textsByLine.get(owner);
    if (list === undefined) textsByLine.set(owner, [text]);
    else list.push(text);
  });
  // 空文本行直接丢弃（正式管线同样丢弃）：ASR 没解出字的片段若留着，Lab 会多出一条空白行，
  // 摘要的「过滤 N 行」还会把它算成语气词。丢弃后再统计说话人，秒数/行数/样例起点与可见行一致。
  const lines: LabLine[] = assigned.utterances
    .map((u, i) => ({
      start: u.start,
      end: u.end,
      speakerId: u.speakerId,
      text: (textsByLine.get(i) ?? []).join(""),
    }))
    .filter((line) => line.text.trim() !== "");
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
