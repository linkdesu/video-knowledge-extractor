import { join, resolve } from "node:path";
import { planClips, clipFileName, cutClip } from "../core/clips";
import { CLIP_PREROLL_SECONDS } from "../core/config";
import { cacheKey, readCache, writeCache, hashJson } from "../core/cache";
import { ensureDir, writeFileAtomic } from "../core/paths";
import { resolveCorrections } from "../core/corrections";
import type { GenerateNotesInput, GenerateNotesResult, LlmClient } from "../core/steps";
import type { Clip, Note, SpeakerId, Topic, TopicId, Utterance, Video } from "../core/types";
import { createLlmClient, tryParseJson } from "../llm/openai";
import { renderIndexMarkdown, renderTopicMarkdown } from "../core/render";

export { renderIndexMarkdown, renderTopicMarkdown };

/** planClips 前移后多个原段落可能并入同一切片;返回该切片覆盖的原段落下标(升序)。 */
function clipSegmentIndexes(origSegments: { start: number; end: number }[], clip: { start: number; end: number }): number[] {
  const out: number[] = [];
  for (let i = 0; i < origSegments.length; i++) {
    const s = origSegments[i];
    if (s === undefined) continue;
    const shiftedStart = Math.max(0, s.start - CLIP_PREROLL_SECONDS);
    if (shiftedStart < clip.end && s.end > clip.start) out.push(i);
  }
  return out;
}
/** 本次要处理的主题:只取调用方分配了目录名的;没分配目录名的跳过(ADR-0014)。 */
function selectedTopics(input: GenerateNotesInput): Topic[] {
  const { topics, dirNames } = input;
  return topics.filter((t) => dirNames.has(t.id));
}

function topicUtterances(topic: Topic, all: Utterance[]): Utterance[] {
  return all.filter((u) => topic.segments.some((s) => u.end > s.start && u.start < s.end));
}

function hms(seconds: number): string {
  const s = Math.floor(Math.max(0, seconds));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}
/** 要点提示词的纠错词表段：视频专属词条优先于全局（ADR-0005）。 */
function correctionLines(input: GenerateNotesInput): string {
  return resolveCorrections(input.corrections)
    .map((e) => `- ${e.from} → ${e.to}`)
    .join("\n");
}

/** 要点提示词全文；测试用它复算缓存键里的提示词哈希。 */
export function noteSystemPrompt(topic: Topic, utterances: Utterance[], input: GenerateNotesInput): string {
  const lines = utterances.map((u) => `[${hms(u.start)} - ${hms(u.end)}] ${u.text}`).join("\n");
  return (
    `根据主题与字幕抽取 3-6 条要点，只输出 JSON {"keyPoints":[string]}。\n` +
    `术语按下表正确写法：\n${correctionLines(input) || "（无）"}\n\n` +
    `主题：${topic.title}\n摘要：${topic.summary}\n\n字幕：\n${lines}`
  );
}

type KeyPoints = { keyPoints: string[] };

async function keyPointsFor(
  input: GenerateNotesInput,
  client: LlmClient,
  topic: Topic,
  utterances: Utterance[],
  usedCacheKeys: Set<string>,
): Promise<string[]> {
  const system = noteSystemPrompt(topic, utterances, input);
  const key = cacheKey("note", {
    topic: hashJson(topic),
    transcript: hashJson(utterances.map((u) => [u.start, u.end, u.speakerId, u.text])),
    prompt: hashJson(system),
    model: input.endpoint.model,
    corrections: hashJson(input.corrections),
  });
  // 无论命中与否，这个键都是本次「用过」的，清理时不能删
  usedCacheKeys.add(key.hash);
  const hit = readCache<KeyPoints>(input.cacheDir, key);
  if (hit !== undefined) return hit.keyPoints;
  const raw = await client.chat([{ role: "system", content: system }], { json: true });
  const parsed = tryParseJson<{ keyPoints?: unknown }>(raw);
  if (parsed === undefined || !Array.isArray(parsed.keyPoints)) return [];
  const points = parsed.keyPoints.filter((p): p is string => typeof p === "string" && p.length > 0);
  writeCache(input.cacheDir, key, { keyPoints: points } satisfies KeyPoints);
  return points;
}

export async function generateNotes(input: GenerateNotesInput): Promise<GenerateNotesResult> {
  const client = input.client ?? createLlmClient(input.endpoint);
  const selected = selectedTopics(input);
  const speakerNames = new Map(input.transcript.speakers.map((s) => [s.id, s.name]));
  const notes: Note[] = [];
  const topicDirs: string[] = [];
  const usedCacheKeys = new Set<string>();
  for (let i = 0; i < selected.length; i++) {
    const topic = selected[i];
    if (topic === undefined) continue;
    input.onProgress?.({ step: "generate-notes", done: i, total: selected.length, detail: topic.title, topicId: topic.id, topicPercent: 0 });
    const dir = input.dirNames.get(topic.id);
    if (dir === undefined) continue;
    const topicDir = ensureDir(resolve(input.video.outputDir, dir));
    const utterances = topicUtterances(topic, input.transcript.utterances);
    const keyPoints = await keyPointsFor(input, client, topic, utterances, usedCacheKeys);
    const clips: Clip[] = [];
    const segments = planClips(topic.segments);
    for (let j = 0; j < segments.length; j++) {
      const segment = segments[j];
      if (segment === undefined) continue;
      const name = clipFileName(segment, j + 1);
      await cutClip({ videoPath: input.video.sourcePath, segment, outPath: join(topicDir, name) });
      clips.push({ topicId: topic.id, segment, path: join(topicDir, name), segmentIndexes: clipSegmentIndexes(topic.segments, segment) });
      input.onProgress?.({ step: "generate-notes", done: i, total: selected.length, detail: topic.title, topicId: topic.id, topicPercent: Math.round(((j + 1) / segments.length) * 100) });
    }
    const markdown = renderTopicMarkdown(topic, utterances, keyPoints, clips, speakerNames);
    writeFileAtomic(join(topicDir, "topic.md"), markdown);
    // 以 topic.md 真正落盘为「本主题已写出」的标记，崩溃时没写成功的目录不在此列
    topicDirs.push(dir);
    notes.push({ topicId: topic.id, markdown, clips });
    input.onTopicProgress?.({ topicId: topic.id, percent: 100, phase: "clips-done" });
  }
  input.onProgress?.({ step: "generate-notes", done: selected.length, total: selected.length });
  // index.md 不再在这里写：调用方从完整文档重建（别的主题的条目要保留，ADR-0014）
  return { notes, topicDirs, noteCacheKeys: [...usedCacheKeys] };
}
