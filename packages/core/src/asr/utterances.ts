import type { Speaker, SpeakerId, Utterance } from "../core/types";
import type { DiarizationSegment } from "./sherpa";

export type UtteranceSpan = { start: number; end: number; speaker: number };

const PALETTE = ["#4f8ef7", "#e8764c", "#5faa55", "#c06bb0", "#d4a63a", "#5bc0c8"];

export function buildSpans(segments: DiarizationSegment[], opts?: { maxSeconds?: number; maxGap?: number }): UtteranceSpan[] {
  const minSegmentSeconds = 0.2;
  const maxSeconds = opts?.maxSeconds ?? 20;
  const maxGap = opts?.maxGap ?? 0.6;
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const spans: UtteranceSpan[] = [];
  for (const s of sorted) {
    if (s.end - s.start < minSegmentSeconds) continue;
    const end = Math.max(s.end, s.start);
    const prev = spans[spans.length - 1];
    if (prev && prev.speaker === s.speaker && s.start - prev.end <= maxGap && end - prev.start <= maxSeconds) {
      prev.end = Math.max(prev.end, end);
      continue;
    }
    spans.push({ start: s.start, end, speaker: s.speaker });
  }
  return spans;
}

export function splitSpan(span: UtteranceSpan, silences: { start: number; end: number }[], maxSeconds: number): UtteranceSpan[] {
  const pieces: UtteranceSpan[] = [];
  let rest: UtteranceSpan = span;
  while (rest.end - rest.start > maxSeconds) {
    const lo = rest.start + maxSeconds / 2;
    const hi = rest.start + maxSeconds;
    let cut = hi;
    let bestDist = Infinity;
    for (const s of silences) {
      const mid = (s.start + s.end) / 2;
      if (mid < lo || mid > hi) continue;
      const d = Math.abs(mid - hi);
      if (d < bestDist) {
        bestDist = d;
        cut = mid;
      }
    }
    pieces.push({ start: rest.start, end: cut, speaker: rest.speaker });
    rest = { start: cut, end: rest.end, speaker: rest.speaker };
  }
  pieces.push(rest);
  return pieces;
}

/**
 * 抢话归属（r70 / #99，r80 / #114）：一段被另一位说话人的话轮整个包住、且自身短到只够一声附和，
 * 就是「插话」。边界容差 0.05s：diarization 的段边界会抖，差几十毫秒不该漏判。
 * 只处理「完全包含」：部分重叠分不清谁插谁的话，两段都留。
 *
 * 插话分两步用：`splitCrosstalk` 把它们从说话人投票里摘出来（不参与 assignSpeakers 的时长统计与编号），
 * 再由 assignSpeakers 单独排成一行——有内容的插话落盘成行，纯语气词的插话由 `filterFillerUtterances` 隐藏。
 */
export const CROSSTALK_TOLERANCE_SECONDS = 0.05;
export const MAX_INTERJECTION_SECONDS = 1;

function isEnclosedInterjection(
  span: UtteranceSpan,
  sorted: readonly UtteranceSpan[],
  maxInterjectionSeconds: number,
): boolean {
  if (span.end - span.start >= maxInterjectionSeconds) return false;
  return sorted.some(
    (other) =>
      other.speaker !== span.speaker &&
      other.start <= span.start + CROSSTALK_TOLERANCE_SECONDS &&
      other.end >= span.end - CROSSTALK_TOLERANCE_SECONDS &&
      other.end - other.start > span.end - span.start,
  );
}

/** 行序：起点、终点、簇号依次比较。assignSpeakers 的输出与输入 span 因此一一对齐（Lab 按此对文本）。 */
export function compareSpans(a: UtteranceSpan, b: UtteranceSpan): number {
  return a.start - b.start || a.end - b.end || a.speaker - b.speaker;
}

export type CrosstalkSplit = {
  /** 参与说话人判断的段（插话已摘出）。 */
  spans: UtteranceSpan[];
  /** 被长段完全包住的短插话，按 start 排序。 */
  interjections: UtteranceSpan[];
};

export function splitCrosstalk(spans: UtteranceSpan[], opts?: { maxInterjectionSeconds?: number }): CrosstalkSplit {
  const maxInterjectionSeconds = opts?.maxInterjectionSeconds ?? MAX_INTERJECTION_SECONDS;
  const sorted = [...spans].sort(compareSpans);
  const voting: UtteranceSpan[] = [];
  const interjections: UtteranceSpan[] = [];
  for (const span of sorted) {
    if (isEnclosedInterjection(span, sorted, maxInterjectionSeconds)) interjections.push(span);
    else voting.push(span);
  }
  return { spans: voting, interjections };
}

/** 只留参与说话人判断的段（r70 的旧调用面）：插话不进投票，行由 assignSpeakers 单独排。 */
export function resolveCrosstalk(spans: UtteranceSpan[], opts?: { maxInterjectionSeconds?: number }): UtteranceSpan[] {
  return splitCrosstalk(spans, opts).spans;
}

export type AssignSpeakersOptions = {
  minSeconds?: number;
  /**
   * 被长段完全包住的短插话（#114）：单独排成一行，但不参与下面的时长统计、说话人保留与编号。
   * 行归属：插话所属簇本身是保留说话人就归它，否则归包住它的那一行（持话轮的一方）。
   */
  interjections?: readonly UtteranceSpan[];
};

export function assignSpeakers(
  spans: UtteranceSpan[],
  opts: AssignSpeakersOptions = {},
): { speakers: Speaker[]; utterances: Utterance[] } {
  const minSeconds = opts.minSeconds ?? 3;
  const interjections = opts.interjections ?? [];
  const sorted = [...spans].sort(compareSpans);

  const totals = new Map<number, number>();
  for (const s of sorted) totals.set(s.speaker, (totals.get(s.speaker) ?? 0) + (s.end - s.start));
  const kept = new Set<number>([...totals.keys()].filter((id) => (totals.get(id) ?? 0) >= minSeconds));
  if (kept.size === 0 && totals.size > 0) {
    // 全部说话人都不足 minSeconds 时，保留总时长最长者（平局取先出现），保证每行都有编号。
    let longest: number | undefined;
    for (const [id, total] of totals) if (longest === undefined || total > (totals.get(longest) ?? 0)) longest = id;
    if (longest === undefined) return { speakers: [], utterances: [] };
    kept.add(longest);
  }
  const order = [...totals.keys()]
    .filter((id) => kept.has(id))
    .sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));

  // 完全无邻可归并时，落到总时长最长的保留者（order[0]）。
  const assign = (s: UtteranceSpan): number => {
    if (kept.has(s.speaker)) return s.speaker;
    let prevEnd = -Infinity;
    let prevId: number | undefined;
    let nextStart = Infinity;
    let nextId: number | undefined;
    for (const o of sorted) {
      if (o.speaker === s.speaker || !kept.has(o.speaker)) continue;
      if (o.end <= s.start) {
        prevEnd = o.end;
        prevId = o.speaker;
      } else if (o.start >= s.end && nextId === undefined) {
        nextStart = o.start;
        nextId = o.speaker;
      }
    }
    const prevGap = s.start - prevEnd;
    const nextGap = nextStart - s.end;
    if (nextId !== undefined && nextGap < prevGap) return nextId;
    if (prevId !== undefined) return prevId;
    const fallback = order[0];
    return fallback !== undefined ? fallback : s.speaker;
  };

  const mapped = sorted.map((s) => ({ ...s, speaker: assign(s) }));

  const ids = new Map(order.map((id, i) => [id, `speaker-${i + 1}` as SpeakerId]));

  /** 插话归谁：所属簇仍是保留说话人就用它，否则归包住它的那一行（持话轮的一方）。 */
  const assignedBySpan = new Map<UtteranceSpan, number>();
  sorted.forEach((span, i) => {
    const row = mapped[i];
    if (row !== undefined) assignedBySpan.set(span, row.speaker);
  });
  const interjectionOwner = (span: UtteranceSpan): number => {
    if (kept.has(span.speaker)) return span.speaker;
    let owner: UtteranceSpan | undefined;
    for (const other of sorted) {
      if (other.start > span.start + CROSSTALK_TOLERANCE_SECONDS) break;
      if (other.end < span.end - CROSSTALK_TOLERANCE_SECONDS) continue;
      if (other.end - other.start <= span.end - span.start) continue;
      if (owner === undefined || other.end - other.start > owner.end - owner.start) owner = other;
    }
    const ownerSpeaker = owner === undefined ? undefined : assignedBySpan.get(owner);
    return ownerSpeaker ?? assign(span);
  };
  const interjectionRows = interjections.map((span) => ({ ...span, speaker: interjectionOwner(span) }));

  const speakers: Speaker[] = order.map((id, i) => {
    const color = PALETTE[i % PALETTE.length];
    if (color === undefined) throw new Error(`调色板越界：${i}`);
    const speakerId = ids.get(id);
    if (speakerId === undefined) throw new Error(`说话人编号缺失：${id}`);
    return { id: speakerId, name: `说话人${i + 1}`, color };
  });
  const utterances: Utterance[] = [...mapped, ...interjectionRows].sort(compareSpans).map((s) => {
    const speakerId = ids.get(s.speaker);
    if (speakerId === undefined) throw new Error(`说话人编号缺失：${s.speaker}`);
    return { start: s.start, end: s.end, speakerId, text: "" };
  });
  return { speakers, utterances };
}
