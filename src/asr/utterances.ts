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

export function assignSpeakers(spans: UtteranceSpan[], opts?: { minSeconds?: number }): { speakers: Speaker[]; utterances: Utterance[] } {
  const minSeconds = opts?.minSeconds ?? 3;
  const sorted = [...spans].sort((a, b) => a.start - b.start);

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

  const speakers: Speaker[] = order.map((id, i) => {
    const color = PALETTE[i % PALETTE.length];
    if (color === undefined) throw new Error(`调色板越界：${i}`);
    const speakerId = ids.get(id);
    if (speakerId === undefined) throw new Error(`说话人编号缺失：${id}`);
    return { id: speakerId, name: `说话人${i + 1}`, color };
  });
  const utterances: Utterance[] = mapped.map((s) => {
    const speakerId = ids.get(s.speaker);
    if (speakerId === undefined) throw new Error(`说话人编号缺失：${s.speaker}`);
    return { start: s.start, end: s.end, speakerId, text: "" };
  });
  return { speakers, utterances };
}
