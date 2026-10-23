import { mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { concatClips, cutClip, planTopicClip } from "../core/clips";
import { SLICE_RE } from "../core/outputs";
import { cacheKey, readCache, writeCache, hashJson } from "../core/cache";
import { logger } from "../core/logger";
import { ensureDir, writeFileAtomic } from "../core/paths";
import { resolveCorrections } from "../core/corrections";
import type { GenerateNotesInput, GenerateNotesResult, LlmClient } from "../core/steps";
import type { Clip, Note, SpeakerId, Topic, TopicId, Utterance, Video } from "../core/types";
import { createLlmClient, tryParseJson } from "../llm/openai";
import { renderIndexMarkdown, renderTopicMarkdown } from "../core/render";

export { renderIndexMarkdown, renderTopicMarkdown };

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
  logger().debug("llm", hit !== undefined ? "要点缓存命中" : "要点缓存未命中", { topicId: topic.id, cacheHit: hit !== undefined });
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
    // 单文件主题切片（r33）：每个 union 切到系统临时目录，concat 成 topic.mp4（流拷贝）
    const { unions, segmentOffsets } = planTopicClip(topic.segments);
    const clipT0 = performance.now();
    if (unions.length > 0) {
      const workDir = mkdtempSync(join(tmpdir(), "vnote-clip-"));
      const parts: string[] = [];
      try {
        for (let j = 0; j < unions.length; j++) {
          const u = unions[j];
          if (u === undefined) continue;
          const part = join(workDir, `${j}.mp4`);
          await cutClip({ videoPath: input.video.sourcePath, segment: u, outPath: part });
          parts.push(part);
          input.onProgress?.({ step: "generate-notes", done: i, total: selected.length, detail: topic.title, topicId: topic.id, topicPercent: Math.round(((j + 1) / unions.length) * 80) });
        }
        const clipPath = join(topicDir, "topic.mp4");
        await concatClips({ parts, outPath: clipPath });
        // 拼接成功后删掉该主题目录里的旧编号切片（旧数据；topic.mp4 本身不在 SLICE_RE 内）
        for (const entry of readdirSync(topicDir)) {
          if (entry !== "topic.mp4" && SLICE_RE.test(entry)) unlinkSync(join(topicDir, entry));
        }
        const first = unions[0];
        const last = unions[unions.length - 1];
        if (first !== undefined && last !== undefined) {
          const segmentIndexes = topic.segments.map((_, n) => n);
          clips.push({ topicId: topic.id, segment: { start: first.start, end: last.end }, path: clipPath, segmentIndexes, segmentOffsets });
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
      logger().info("llm", "切片完成", { clipCount: parts.length, durationMs: Math.round(performance.now() - clipT0) });
    }
    const markdown = renderTopicMarkdown(topic, utterances, keyPoints, clips, speakerNames);
    writeFileAtomic(join(topicDir, "topic.md"), markdown);
    logger().info("llm", "笔记生成完成", { topicId: topic.id, markdownBytes: Buffer.byteLength(markdown, "utf8") });
    // 以 topic.md 真正落盘为「本主题已写出」的标记，崩溃时没写成功的目录不在此列
    topicDirs.push(dir);
    notes.push({ topicId: topic.id, markdown, clips });
    input.onTopicProgress?.({ topicId: topic.id, percent: 100, phase: "clips-done" });
  }
  input.onProgress?.({ step: "generate-notes", done: selected.length, total: selected.length });
  // index.md 不再在这里写：调用方从完整文档重建（别的主题的条目要保留，ADR-0014）
  return { notes, topicDirs, noteCacheKeys: [...usedCacheKeys] };
}
