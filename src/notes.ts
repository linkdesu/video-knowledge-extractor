import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chatJson, LLM_MODEL } from "./llm";
import type { Cue } from "./transcript";
import type { Keyframe } from "../scripts/deprecated/frames";
import { hamming56 } from "../scripts/deprecated/frames";
import { fmtTime, pool } from "./util";

export type NoteSection = {
  heading: string;
  start: number;
  end: number;
  points: string[];
  quote: string;
  image?: Keyframe;
};

export type Notes = {
  title: string;
  video: string;
  duration: number;
  asrModel: string;
  llmModel: string;
  generatedAt: string;
  summary: string[];
  takeaways: string[];
  sections: NoteSection[];
};

type RawSection = { heading?: unknown; start?: unknown; end?: unknown; points?: unknown; quote?: unknown };

function sanitize(raw: RawSection[], winStart: number, winEnd: number): NoteSection[] {
  const out: NoteSection[] = [];
  for (const s of raw) {
    const heading = String(s.heading ?? "").replace(/\s+/g, " ").trim().slice(0, 26);
    if (!heading) continue;
    let start = Number(s.start);
    let end = Number(s.end);
    if (!Number.isFinite(start)) start = winStart;
    if (!Number.isFinite(end)) end = winEnd;
    start = Math.max(winStart, Math.min(start, winEnd));
    end = Math.max(winStart, Math.min(end, winEnd));
    if (end < start) [start, end] = [end, start];
    if (end - start < 5) start = Math.max(winStart, end - Math.min(90, (winEnd - winStart) * 0.3));
    const points = (Array.isArray(s.points) ? s.points : [])
      .map((p) => String(p).replace(/\s+/g, " ").trim().slice(0, 70))
      .filter(Boolean)
      .slice(0, 3);
    if (points.length === 0) continue;
    const quote = String(s.quote ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    out.push({ heading, start, end, points, quote });
  }
  return out;
}

function windowText(cues: Cue[], start: number, end: number): string {
  const lines: string[] = [];
  let size = 0;
  for (const c of cues) {
    if (c.end <= start || c.start >= end) continue;
    const line = `[${fmtTime(c.start)}] ${c.text}`;
    if (size + line.length > 6000) break;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

async function summarizeWindow(
  cues: Cue[],
  winStart: number,
  winEnd: number,
  cacheFile: string,
  force: boolean,
): Promise<NoteSection[]> {
  if (!force && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as NoteSection[];
      if (Array.isArray(cached) && cached.length > 0) return cached;
    } catch {
      // ignore
    }
  }
  const text = windowText(cues, winStart, winEnd);
  if (text.length < 20) return [];
  const prompt = `你是视频笔记整理助手。下面是一段直播/讲解录屏的语音转写，时间范围 ${fmtTime(winStart)}–${fmtTime(winEnd)}（${Math.round(winStart)}–${Math.round(winEnd)} 秒）。
请只依据转写内容，按主题分成 2-4 段。不要补充转写中没有的信息，不要复述口水话。
输出严格 JSON（不要 markdown 代码块）：
{"sections":[{"heading":"中文小标题<=18字","start":起始秒整数,"end":结束秒整数,"points":["要点<=40字","要点"],"quote":"原文中的一句关键话<=30字"}]}
要求：
- start/end 必须在 ${Math.round(winStart)} 到 ${Math.round(winEnd)} 之间，且覆盖该主题的实际时间；
- 每段 2-3 条要点，每条是一个完整判断，不要写"主播说"；
- quote 必须从转写原文中截取，不要改写。

转写：
${text}`;
  const raw = await chatJson<{ sections?: RawSection[] }>([
    { role: "system", content: "你是严谨的中文视频笔记编辑，只输出 JSON。" },
    { role: "user", content: prompt },
  ], 1100);
  const sections = sanitize(Array.isArray(raw.sections) ? raw.sections : [], winStart, winEnd);
  if (sections.length === 0) throw new Error(`窗口 ${fmtTime(winStart)} 没有解析出主题`);
  writeFileSync(cacheFile, JSON.stringify(sections, null, 1));
  return sections;
}

async function overview(sections: NoteSection[], force: boolean, cacheFile: string): Promise<{ title: string; summary: string[]; takeaways: string[] }> {
  if (!force && existsSync(cacheFile)) {
    try {
      return JSON.parse(readFileSync(cacheFile, "utf8")) as { title: string; summary: string[]; takeaways: string[] };
    } catch {
      // ignore
    }
  }
  const digest = sections
    .map((s) => `- ${fmtTime(s.start)}–${fmtTime(s.end)} ${s.heading}: ${s.points.join("；")}`)
    .join("\n")
    .slice(0, 6000);
  const raw = await chatJson<{ title?: string; summary?: unknown; takeaways?: unknown }>([
    { role: "system", content: "你是严谨的中文视频笔记编辑，只输出 JSON。" },
    {
      role: "user",
      content: `下面是按时间整理好的视频笔记分段。请写总览，只依据这些内容：
{"title":"整场内容标题<=20字","summary":["3-5条核心结论，每条<=50字"],"takeaways":["2-3条可执行建议，每条<=50字"]}
只输出 JSON。

${digest}`,
    },
  ], 800);
  const out = {
    title: String(raw.title ?? "视频笔记").replace(/\s+/g, " ").trim().slice(0, 30),
    summary: (Array.isArray(raw.summary) ? raw.summary : []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 5),
    takeaways: (Array.isArray(raw.takeaways) ? raw.takeaways : []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 3),
  };
  writeFileSync(cacheFile, JSON.stringify(out, null, 1));
  return out;
}

function pickImages(sections: NoteSection[], frames: Keyframe[], maxImages: number, duration: number): void {
  const used = new Set<string>();
  const buckets = Math.max(1, Math.min(maxImages, sections.length));
  const bucketSize = duration / buckets;
  const chosenHashes: bigint[] = [];
  for (let b = 0; b < buckets; b++) {
    const bStart = b * bucketSize;
    const bEnd = b === buckets - 1 ? duration : bStart + bucketSize;
    const local = sections.filter((s) => s.start < bEnd && s.end > bStart && !s.image);
    if (local.length === 0) continue;
    const candidates = frames.filter((f) => !used.has(f.file) && f.time >= bStart && f.time <= bEnd);
    let best: Keyframe | null = null;
    let bestScore = -Infinity;
    for (const f of candidates) {
      if (f.hash && chosenHashes.some((h) => hamming56(h, BigInt(f.hash!)) < 12)) continue;
      const target = local.find((s) => f.time >= s.start && f.time <= s.end);
      const score = f.score - (target ? 0 : 40) - Math.abs(f.time - bStart) / 100;
      if (score > bestScore) {
        best = f;
        bestScore = score;
      }
    }
    if (!best) continue;
    if (best.hash) chosenHashes.push(BigInt(best.hash));
    const owner = local.find((s) => best!.time >= s.start && best!.time <= s.end)
      ?? local.reduce((a, s) => (Math.abs(s.start - best!.time) < Math.abs(a.start - best!.time) ? s : a));
    owner.image = best;
    used.add(best.file);
  }
}

export async function buildNotes(opts: {
  video: string;
  duration: number;
  cues: Cue[];
  frames: Keyframe[];
  asrModel: string;
  windowSec: number;
  cacheDir: string;
  force: boolean;
  maxImages: number;
  concurrency: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<Notes> {
  const windows: { start: number; end: number }[] = [];
  for (let t = 0; t < opts.duration; t += opts.windowSec) {
    windows.push({ start: t, end: Math.min(opts.duration, t + opts.windowSec) });
  }
  const active = windows.filter((w) => opts.cues.some((c) => c.end > w.start && c.start < w.end));
  let done = 0;
  const results = await pool(active, opts.concurrency, async (w) => {
    const cacheFile = `${opts.cacheDir}/window_${String(w.start).padStart(5, "0")}.json`;
    try {
      return await summarizeWindow(opts.cues, w.start, w.end, cacheFile, opts.force);
    } finally {
      done++;
      opts.onProgress?.(done, active.length);
    }
  });

  const sections = results.flat().sort((a, b) => a.start - b.start);
  const merged: NoteSection[] = [];
  for (const s of sections) {
    const prev = merged[merged.length - 1];
    if (prev && prev.heading === s.heading && s.start - prev.end < 90) {
      prev.end = Math.max(prev.end, s.end);
      prev.points = [...new Set([...prev.points, ...s.points])].slice(0, 3);
      continue;
    }
    merged.push({ ...s });
  }

  const head = await overview(merged, opts.force, `${opts.cacheDir}/overview.json`);
  pickImages(merged, opts.frames, opts.maxImages, opts.duration);
  return {
    title: head.title,
    video: opts.video,
    duration: opts.duration,
    asrModel: opts.asrModel,
    llmModel: LLM_MODEL,
    generatedAt: new Date().toISOString(),
    summary: head.summary,
    takeaways: head.takeaways,
    sections: merged,
  };
}
