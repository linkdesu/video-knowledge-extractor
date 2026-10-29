import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { concatClips, cutClip, planTopicClip } from "../core/clips";
import { SLICE_RE } from "../core/outputs";
import { cacheKey, readCache, writeCache, hashJson } from "../core/cache";
import { logger } from "../core/logger";
import { ensureDir, writeFileAtomic } from "../core/paths";
import { resolveCorrections } from "../core/corrections";
import { promptFingerprint, renderPrompt } from "../core/prompts";
import type { PromptFingerprint } from "../core/prompts";
import type { GenerateNotesInput, GenerateNotesResult, LlmClient, TrajectoryTrigger } from "../core/steps";
import type { Clip, Note, SpeakerId, Topic, TopicId, Utterance, Video } from "../core/types";
import { createLlmClient, tryParseJson } from "../llm/openai";
import { renderIndexMarkdown, renderTopicMarkdown } from "../core/render";
import { speakerNameMap } from "../core/speaker-map";
import { appendTrajectory } from "../core/trajectory";
import type { TrajectoryRequest } from "../core/trajectory";

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

/**
 * Resolved host names, in the order the caller listed them: unknown ids and repeated names
 * (merged speakers can map several ids to one name) are dropped. Logs and the trajectory record
 * carry these names, never speaker ids.
 */
function hostNames(input: GenerateNotesInput): string[] {
  const names = speakerNameMap(input.transcript.speakers);
  const resolved: string[] = [];
  for (const id of input.hosts ?? []) {
    const name = names.get(id);
    if (name === undefined || resolved.includes(name)) continue;
    resolved.push(name);
  }
  return resolved;
}

/**
 * 要点提示词的主播段：没有主播、或 id 都解析不到说话人时返回空串（不渲染空 `主播：` 行）；
 * 否则一行说明主播观点是主要内容，其余发言只是问题或上下文。
 */
function hostLine(hosts: readonly string[]): string {
  if (hosts.length === 0) return "";
  return `主播：${hosts.join("、")}。以主播的观点为主要内容，其他人的发言只作为问题或上下文。\n`;
}

/** 要点提示词全文（r46 起走提示词注册表）；测试用它复算缓存键里的提示词哈希。 */
export function noteSystemPrompt(topic: Topic, utterances: Utterance[], input: GenerateNotesInput): string {
  const lines = utterances.map((u) => `[${hms(u.start)} - ${hms(u.end)}] ${u.text}`).join("\n");
  return renderPrompt(
    "note-key-points",
    {
      HOSTS: hostLine(hostNames(input)),
      GLOSSARY: correctionLines(input) || "（无）",
      TOPIC_TITLE: topic.title,
      TOPIC_SUMMARY: topic.summary,
      UTTERANCES: lines,
    },
    input.prompts,
  );
}

type KeyPoints = { keyPoints: string[] };

/** One topic's rendered prompt plus what the log line and trajectory record may carry (never the body). */
type NotePrompt = { text: string; fingerprint: PromptFingerprint; hosts: string[] };

function notePrompt(topic: Topic, utterances: Utterance[], input: GenerateNotesInput): NotePrompt {
  const text = noteSystemPrompt(topic, utterances, input);
  return { text, fingerprint: promptFingerprint("note-key-points", text, input.prompts), hosts: hostNames(input) };
}

/** 取要点：缓存命中时 `rawText` 为 null（没调用模型）；模型输出不是合法要点 JSON 时报错（失败不落缓存）。 */
async function keyPointsFor(
  input: GenerateNotesInput,
  client: LlmClient,
  topic: Topic,
  utterances: Utterance[],
  prompt: NotePrompt,
  usedCacheKeys: Set<string>,
): Promise<{ points: string[]; rawText: string | null; keyHash: string; cached: boolean }> {
  const key = cacheKey("note", {
    topic: hashJson(topic),
    transcript: hashJson(utterances.map((u) => [u.start, u.end, u.speakerId, u.text])),
    prompt: hashJson(prompt.text),
    model: input.endpoint.model,
    // 端点也是输入：切 baseUrl（模型名不变）不能复用旧端点的答案；去尾斜杠避免同一端点两种写法
    baseUrl: input.endpoint.baseUrl.trim().replace(/\/+$/, ""),
    corrections: hashJson(input.corrections),
  });
  // 无论命中与否，这个键都是本次「用过」的，清理时不能删
  usedCacheKeys.add(key.hash);
  const kpStart = performance.now();
  // 用户点「重新生成」要的就是新答案：跳过磁盘缓存，真实请求模型后覆写同一键
  const hit = input.trigger === "regenerate" ? undefined : readCache<KeyPoints>(input.cacheDir, key);
  logger().info("llm", hit !== undefined ? "要点缓存命中" : "要点缓存未命中", { topicId: topic.id, cacheHit: hit !== undefined });
  let points: string[];
  let rawText: string | null = null;
  if (hit !== undefined) {
    points = hit.keyPoints;
  } else {
    logger().info("llm", "提示词版本", {
      promptId: prompt.fingerprint.id,
      promptSource: prompt.fingerprint.source,
      promptSha256: prompt.fingerprint.sha256,
      model: client.model,
      kind: "note-key-points",
      hosts: prompt.hosts,
    });
    const raw = await client.chat([{ role: "system", content: prompt.text }], { json: true });
    const parsed = tryParseJson<{ keyPoints?: unknown }>(raw);
    if (parsed === undefined || !Array.isArray(parsed.keyPoints)) throw new Error("LLM 返回格式错误：无法解析要点 JSON");
    points = parsed.keyPoints.filter((p): p is string => typeof p === "string" && p.length > 0);
    writeCache(input.cacheDir, key, { keyPoints: points } satisfies KeyPoints);
    rawText = raw;
  }
  logger().info("llm", "要点提取完成", { topicId: topic.id, pointCount: points.length, cacheHit: hit !== undefined, durationMs: Math.round(performance.now() - kpStart) });
  return { points, rawText, keyHash: key.hash, cached: hit !== undefined };
}

export async function generateNotes(input: GenerateNotesInput): Promise<GenerateNotesResult> {
  const client = input.client ?? createLlmClient(input.endpoint);
  const selected = selectedTopics(input);
  const speakerNames = speakerNameMap(input.transcript.speakers);
  const notes: Note[] = [];
  const topicDirs: string[] = [];
  const usedCacheKeys = new Set<string>();
  const cacheHits: string[] = [];
  // 整批位置由调用方给出（逐主题调用本函数时不能退化成 1/1）；缺省按本次选中的主题数
  const batchIndex = input.batch?.index;
  const batchTotal = input.batch?.total ?? selected.length;
  for (let i = 0; i < selected.length; i++) {
    const topic = selected[i];
    if (topic === undefined) continue;
    const done = batchIndex ?? i;
    input.onProgress?.({ step: "generate-notes", done, total: batchTotal, detail: topic.title, topicId: topic.id, topicPercent: 0 });
    const dir = input.dirNames.get(topic.id);
    if (dir === undefined) continue;
    const topicDir = ensureDir(resolve(input.video.outputDir, dir));
    const utterances = topicUtterances(topic, input.transcript.utterances);
    // 请求形状提到循环体里：缓存命中与 LLM 调用两条路径都能写进轨迹
    const prompt = notePrompt(topic, utterances, input);
    // 请求只记录端点的 baseUrl/model 与提示词指纹：凭据与提示词正文都不进轨迹
    const request: TrajectoryRequest = {
      baseUrl: input.endpoint.baseUrl,
      model: input.endpoint.model,
      prompt: { ...prompt.fingerprint, hosts: prompt.hosts, chars: prompt.text.length },
      glossaryCount: resolveCorrections(input.corrections).length,
    };
    const trigger = input.trigger ?? "initial";
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    try {
      const { points, rawText, keyHash, cached } = await keyPointsFor(input, client, topic, utterances, prompt, usedCacheKeys);
      if (cached) cacheHits.push(keyHash);
      const clips: Clip[] = [];
      // 单文件主题切片（r33）：每个 union 切到系统临时目录，concat 成 topic.mp4（流拷贝）
      const { unions, segmentOffsets } = planTopicClip(topic.segments);
      // 没有可切片的时间段：拒绝生成，主题不能在没有 topic.mp4 时达到 done
      if (unions.length === 0) throw new Error(`主题 ${topic.title} 没有可切片的时间段`);
      const clipT0 = performance.now();
      const workDir = mkdtempSync(join(tmpdir(), "vnote-clip-"));
      const parts: string[] = [];
      try {
        for (let j = 0; j < unions.length; j++) {
          const u = unions[j];
          if (u === undefined) continue;
          const part = join(workDir, `${j}.mp4`);
          await cutClip({ videoPath: input.video.sourcePath, segment: u, outPath: part, hasVideo: input.hasVideo });
          parts.push(part);
          input.onProgress?.({ step: "generate-notes", done, total: batchTotal, detail: topic.title, topicId: topic.id, topicPercent: Math.round(((j + 1) / unions.length) * 80) });
        }
        const clipPath = join(topicDir, "topic.mp4");
        await concatClips({ parts, outPath: clipPath, hasVideo: input.hasVideo });
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
      logger().info("ffmpeg", "主题视频切片完成", { topicId: topic.id, clipCount: parts.length, durationMs: Math.round(performance.now() - clipT0) });
      const markdown = renderTopicMarkdown(topic, utterances, points, clips, speakerNames);
      writeFileAtomic(join(topicDir, "topic.md"), markdown);
      logger().info("llm", "笔记生成完成", { topicId: topic.id, markdownBytes: Buffer.byteLength(markdown, "utf8") });
      appendTrajectory(topicDir, { topicId: topic.id, topicTitle: topic.title }, {
        runId: randomUUID(),
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        trigger,
        request,
        response: { status: "succeeded", rawText, parsedSummary: points, error: null },
        clip: { clipFile: "topic.mp4", segments: topic.segments, status: "ready" },
      });
      logger().info("fs", "落盘完成", { topicMd: join(topicDir, "topic.md"), trajectory: join(topicDir, "trajectory.json") });
      // 以 topic.md 真正落盘为「本主题已写出」的标记，崩溃时没写成功的目录不在此列
      topicDirs.push(dir);
      notes.push({ topicId: topic.id, markdown, clips });
      input.onTopicProgress?.({ topicId: topic.id, percent: 100, phase: "clips-done" });
    } catch (err) {
      // 失败也追加一条记录（rawText 在响应到达前的失败保持 null），原错误不动样上抛
      appendTrajectory(topicDir, { topicId: topic.id, topicTitle: topic.title }, {
        runId: randomUUID(),
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        trigger,
        request,
        response: { status: "failed", rawText: null, parsedSummary: null, error: err instanceof Error ? err.message : String(err) },
        clip: { clipFile: null, segments: topic.segments, status: "failed" },
      });
      const e = err instanceof Error ? err : new Error(String(err));
      logger().error("llm", "主题生成失败", { topicId: topic.id, title: topic.title, error: e.message, stack: e.stack });
      throw err;
    }
  }
  input.onProgress?.({ step: "generate-notes", done: (batchIndex ?? 0) + selected.length, total: batchTotal });
  // index.md 不再在这里写：调用方从完整文档重建（别的主题的条目要保留，ADR-0014）
  return { notes, topicDirs, noteCacheKeys: [...usedCacheKeys], cacheHits };
}
