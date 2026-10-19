import { srtTime } from "./util";
import type { CachedAsr } from "./asr";
import { applyGlossary } from "./glossary";

export type Cue = { start: number; end: number; text: string };

export type Transcript = {
  video: string;
  duration: number;
  model: string;
  generatedAt: string;
  cues: Cue[];
  chunks: { index: number; start: number; end: number; cached: boolean }[];
};

function splitLong(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = -1;
    for (let i = max; i >= Math.max(6, Math.floor(max * 0.5)); i--) {
      if (/[，,、：: ]/.test(rest[i - 1] ?? "")) {
        cut = i;
        break;
      }
    }
    if (cut < 0) cut = max;
    // 不要把一个英文/数字词切成两半（SQL、Claude、2.0 之类）
    if (/[A-Za-z0-9]/.test(rest[cut - 1] ?? "") && /[A-Za-z0-9]/.test(rest[cut] ?? "")) {
      let left = cut;
      while (left > 6 && /[A-Za-z0-9.]/.test(rest[left - 1] ?? "")) left--;
      let right = cut;
      while (right < rest.length && /[A-Za-z0-9.]/.test(rest[right] ?? "")) right++;
      cut = left > rest.length * 0.35 ? left : right;
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** 把一段（约 15s）转写按标点拆成字幕，时长按字数比例分配。 */
export function splitCues(text: string, start: number, end: number): Cue[] {
  const clean = text.replace(/\s+/g, "").trim();
  if (!clean) return [];
  if (clean.length <= 24) return [{ start, end, text: clean }];

  const raw = clean.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? [clean];
  const parts: string[] = [];
  for (const clause of raw) {
    const t = clause.trim();
    if (!t) continue;
    if (t.length > 24) parts.push(...splitLong(t, 22));
    else parts.push(t);
  }
  const merged: string[] = [];
  for (const p of parts) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && (prev.length < 5 || p.length < 5 || prev.length + p.length <= 22)) {
      merged[merged.length - 1] = prev + p;
    } else {
      merged.push(p);
    }
  }

  const totalChars = merged.reduce((n, s) => n + s.length, 0);
  const dur = Math.max(0.2, end - start);
  const cues: Cue[] = [];
  let cursor = start;
  for (let i = 0; i < merged.length; i++) {
    const piece = merged[i]!;
    const share = totalChars > 0 ? piece.length / totalChars : 1 / merged.length;
    const cueEnd = i === merged.length - 1 ? end : Math.min(end, Math.max(cursor + 0.5, cursor + dur * share));
    cues.push({ start: cursor, end: cueEnd, text: piece });
    cursor = cueEnd;
  }
  return cues;
}

export function buildTranscript(
  video: string,
  duration: number,
  model: string,
  results: CachedAsr[],
  glossary: Record<string, string> = {},
): Transcript {
  const cues: Cue[] = [];
  for (const { chunk, result } of [...results].sort((a, b) => a.chunk.start - b.chunk.start)) {
    const segments = result.segments.length
      ? result.segments
      : [{ text: result.text, start: 0, end: chunk.end - chunk.start }];
    for (const seg of segments) {
      const text = applyGlossary(seg.text, glossary);
      cues.push(...splitCues(text, chunk.start + seg.start, chunk.start + seg.end));
    }
  }
  return {
    video,
    duration,
    model,
    generatedAt: new Date().toISOString(),
    cues,
    chunks: results.map((r) => ({
      index: r.chunk.index,
      start: r.chunk.start,
      end: r.chunk.end,
      cached: r.cached,
    })),
  };
}

export function toSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join("\n");
}
