/**
 * 把一组标签组装成 Lab 字幕行（r48）：复用 core 的 buildSpans → splitSpan → resolveCrosstalk →
 * assignSpeakers，文本由段级解码结果按时间归属；不复制也不修改正式管线。
 */
import { assignSpeakers, buildSpans, resolveCrosstalk, splitSpan } from "@video-notes/core";
import type { DiarizationSegment } from "@video-notes/core";
import type { LabConfigName, LabLine, LabSpeaker } from "../../shared/lab";

export type LabTextRow = { start: number; end: number; text: string };

const MAX_SPAN_SECONDS = 30;

/** 重叠判定的容差：只擦过边界的文本行不算与这一段有交集（吸收 diarization 的边界抖动）。 */
const OWNER_MARGIN = 0.02;

/**
 * 每段文本只归属一段 span（#97 + r70 / #99）：一段文本只有一个归属，文字像不像不参与判定。
 * - 时间：取重叠秒数最多的那段；重叠不超过 `OWNER_MARGIN` 的没有资格。
 * - 说话人：重叠等长时（一段文本被两段完整覆盖，抢话处常见）回它自己的说话人那段。说话人取自文本行
 *   所属分离段的标签——segtext.rows 与 segments 一一对应（analysis-cache 按此校验行数）。
 * - 起点：说话人证据打平时（标签未知，或文本行只有一份而分离段有多段）取起点更贴近文本行的那段。
 * 旧口径「有一点时间交集就拼进来」会把同一句话拼进两行——听声音是两句不同的话，看起来却重复。
 */
function textOwners(rows: LabTextRow[], spans: { start: number; end: number; speaker: number }[], rowSpeakers: (number | undefined)[]): number[] {
  return rows.map((row, r) => {
    let owner = -1;
    let bestOverlap = 0;
    let bestSpeaker = false;
    let bestOffset = Infinity;
    spans.forEach((span, i) => {
      const overlap = Math.min(span.end, row.end) - Math.max(span.start, row.start);
      if (overlap <= OWNER_MARGIN) return;
      const sameSpeaker = rowSpeakers[r] !== undefined && rowSpeakers[r] === span.speaker;
      const offset = Math.abs(span.start - row.start);
      const better =
        overlap > bestOverlap + 1e-9 ||
        (Math.abs(overlap - bestOverlap) <= 1e-9 && (sameSpeaker !== bestSpeaker ? sameSpeaker : offset < bestOffset));
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
  const rawSpans = buildSpans(labelled).flatMap((span) => splitSpan(span, input.silences, MAX_SPAN_SECONDS));
  const spans = resolveCrosstalk(rawSpans);
  const assigned = assignSpeakers(spans);
  // 归属先落在被拆出的原始 span 上，再看它有没有被抢话规则并走（并走时下标为 -1）：被并入的插话段的
  // 文本随之丢弃——抢话处的音频已经算在持话轮者的行里（正式管线解码那段音频同样会带到），再拼一遍就是复制。
  const lineOfSpan = rawSpans.map((span) => spans.indexOf(span));
  // 说话人证据必须与 span 的编号同源：span 的 speaker 来自 `labels`（二次聚类整理后的标签），
  // 这里读 `seg.speaker`（分离模型的原始簇号）就会拿两套编号互相比，证据错配——插话文本凭假匹配
  // 抢进主播行（r73c 回归：15:37「好的话。」又拼回主播行）。
  const rowSpeakers = input.texts.length === input.segments.length ? input.segments.map((_, i) => input.labels[i]) : [];
  const owners = textOwners(input.texts, rawSpans, rowSpeakers);
  const textByLine = new Map<number, string[]>();
  input.texts.forEach((row, i) => {
    const spanIndex = owners[i];
    if (spanIndex === undefined || spanIndex < 0) return;
    const line = lineOfSpan[spanIndex];
    if (line === undefined || line < 0) return;
    const text = row.text.trim();
    if (text === "") return;
    const list = textByLine.get(line);
    if (list === undefined) textByLine.set(line, [text]);
    else list.push(text);
  });
  // 空文本行直接丢弃（正式管线同样丢弃）：ASR 没解出字的片段若留着，Lab 会多出一条空白行，
  // 摘要的「过滤 N 行」还会把它算成语气词。丢弃后再统计说话人，秒数/行数/样例起点与可见行一致。
  const lines: LabLine[] = assigned.utterances
    .map((u, i) => ({
      start: u.start,
      end: u.end,
      speakerId: u.speakerId,
      text: (textByLine.get(i) ?? []).join(""),
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
