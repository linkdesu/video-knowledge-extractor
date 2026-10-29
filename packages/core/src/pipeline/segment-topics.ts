import { cacheKey, hashJson, readCache, writeCache } from "../core/cache";
import { resolveCorrections } from "../core/corrections";
import { logger } from "../core/logger";
import { promptFingerprint, renderPrompt } from "../core/prompts";
import { hostNames as resolveHostNames } from "../core/speaker-map";
import { createLlmClient, parseJsonLoose } from "../llm/openai";
import type { SegmentTopicsInput, SegmentTopicsResult } from "../core/steps";
import type { Segment, Topic, TopicId } from "../core/types";

type RawTopic = {
  title?: unknown;
  summary?: unknown;
  segments?: unknown;
};

type RawResponse = { topics?: RawTopic[] };

/** 模型偶尔把单个主题直接吐成顶层对象，这种回复不能当结果用，也不能进缓存。 */
function topicsOf(raw: RawResponse | undefined): RawTopic[] | undefined {
  return Array.isArray(raw?.topics) ? raw.topics : undefined;
}

function requireTopics(raw: RawResponse | undefined, text: string, label: string): RawTopic[] {
  const topics = topicsOf(raw);
  if (topics === undefined) {
    throw new Error(`${label}失败：模型没有返回 topics 数组（返回开头：${text.slice(0, 200)}）`);
  }
  return topics;
}

/** 术语表段：合并后（本视频优先于全局）的正确写法，随提示词一起进缓存键。 */
function glossarySection(corrections: SegmentTopicsInput["corrections"]): string {
  const entries = resolveCorrections(corrections ?? { global: [], video: [] });
  if (entries.length === 0) return "";
  return `术语按下表正确写法：\n${entries.map((e) => `- ${e.from} → ${e.to}`).join("\n")}\n`;
}

/**
 * 主题划分/合并提示词的主播段（r47）：只声明谁是主播，不做加权；没有主播或 id 都解析不到时为空串，
 * 保证默认渲染与 r46 逐字一致。主题归属仍由模型自己判断。
 */
function hostsSection(input: SegmentTopicsInput): string {
  const names = resolveHostNames(input.transcript.speakers, input.hosts);
  if (names.length === 0) return "";
  return `主播：${names.join("、")}。划分主题时以主播发起或回答的话题为主线，其他人的发言作为提问或上下文。\n`;
}

function renderChunkLines(input: SegmentTopicsInput, chunkIndex: number): string[] {
  const chunk = input.chunks[chunkIndex];
  if (chunk === undefined) return [];
  const lines: string[] = [];
  for (const u of input.transcript.utterances) {
    if (u.start < chunk.end && u.end > chunk.start) {
      const speaker = input.transcript.speakers.find((s) => s.id === u.speakerId);
      lines.push(`[${u.start.toFixed(1)}-${u.end.toFixed(1)}] ${speaker?.name ?? "说话人"}: ${u.text}`);
    }
  }
  return lines;
}

function sanitizeTopics(raw: RawTopic[], maxEnd: number): Topic[] {
  const topics: Array<Omit<Topic, "id">> = [];
  for (const t of raw) {
    const title = typeof t.title === "string" ? t.title.trim() : "";
    const summary = typeof t.summary === "string" ? t.summary : "";
    if (title === "") continue;
    const segs: Segment[] = [];
    if (Array.isArray(t.segments)) {
      for (const s of t.segments) {
        if (typeof s !== "object" || s === null || !("start" in s) || !("end" in s)) continue;
        const st = s.start;
        const en = s.end;
        if (typeof st !== "number" || typeof en !== "number") continue;
        if (!Number.isFinite(st) || !Number.isFinite(en)) continue;
        const start = Math.min(Math.max(st, 0), maxEnd);
        const end = Math.min(Math.max(en, 0), maxEnd);
        if (end > start) segs.push({ start, end });
      }
    }
    if (segs.length === 0) continue;
    segs.sort((a, b) => a.start - b.start);
    const merged: Segment[] = [];
    for (const s of segs) {
      const last = merged[merged.length - 1];
      if (last !== undefined && s.start <= last.end) {
        last.end = Math.max(last.end, s.end);
      } else {
        merged.push({ ...s });
      }
    }
    topics.push({ title, summary, segments: merged });
  }
  topics.sort((a, b) => (a.segments[0]?.start ?? 0) - (b.segments[0]?.start ?? 0));
  return topics.map((t, i) => ({
    ...t,
    id: `topic-${i + 1}` as TopicId,
  }));
}

export async function segmentTopics(input: SegmentTopicsInput): Promise<SegmentTopicsResult> {
  const client = input.client ?? createLlmClient(input.endpoint);
  const maxEnd = input.transcript.utterances.reduce((m, u) => Math.max(m, u.end), 0);
  const candidates: RawTopic[] = [];
  const glossary = glossarySection(input.corrections);
  const hosts = hostsSection(input);
  // 提示词来自 core 的注册表（r46）：用户覆盖优先，没有覆盖时与旧字符串逐字一致，旧缓存继续命中；
  // r47 起主播段随提示词进缓存键（主播变了自然换键）
  const chunkPrompt = renderPrompt("segment-chunk", { HOSTS: hosts, GLOSSARY: glossary }, input.prompts);
  const chunkFingerprint = promptFingerprint("segment-chunk", chunkPrompt, input.prompts);
  const chunkPromptHash = hashJson(chunkPrompt);
  const startedAt = performance.now();

  for (let i = 0; i < input.chunks.length; i++) {
    const chunk = input.chunks[i];
    if (chunk === undefined) continue;
    const lines = renderChunkLines(input, i);
    let cacheHit = false;
    let addedTopics = 0;
    const chunkStart = performance.now();
    const preCandidateCount = candidates.length;
    logger().info("llm", `主题分析分块 (${i + 1}/${input.chunks.length}) 开始`, { chunkIndex: i + 1, chunkCount: input.chunks.length });
    if (lines.length > 0) {
      const key = cacheKey("topic-candidates", {
        chunk: hashJson(lines),
        prompt: chunkPromptHash,
        model: input.endpoint.model,
      });
      let topics = topicsOf(readCache<RawResponse>(input.cacheDir, key));
      cacheHit = topics !== undefined;
      if (topics === undefined) {
        // fingerprint only: the prompt body never reaches the log
        logger().info("llm", "提示词版本", {
          promptId: chunkFingerprint.id,
          promptSource: chunkFingerprint.source,
          promptSha256: chunkFingerprint.sha256,
          model: client.model,
          kind: "chunk",
          hosts: resolveHostNames(input.transcript.speakers, input.hosts),
        });
        const text = await client.chat([
          { role: "system", content: chunkPrompt },
          { role: "user", content: `该块范围 [${chunk.start}-${chunk.end}]：\n${lines.join("\n")}` },
        ], { json: true });
        topics = requireTopics(parseJsonLoose<RawResponse>(text), text, `第 ${i + 1} 块主题分析`);
        writeCache(input.cacheDir, key, { topics });
      }
      candidates.push(...topics);
    }
    addedTopics = candidates.length - preCandidateCount;
    logger().info("llm", `主题分析分块 (${i + 1}/${input.chunks.length}) 完成`, { topicCount: addedTopics, cacheHit, model: client.model, durationMs: Math.round(performance.now() - chunkStart) });
    input.onProgress?.({ step: "segment-topics", done: i + 1, total: input.chunks.length });
  }
  if (candidates.length === 0) {
    logger().info("llm", "划主题完成", { topics: 0, durationMs: Math.round(performance.now() - startedAt), model: client.model });
    return { topics: [] };
  }

  const mergePrompt = renderPrompt("segment-merge", { HOSTS: hosts, GLOSSARY: glossary }, input.prompts);
  const mergeFingerprint = promptFingerprint("segment-merge", mergePrompt, input.prompts);
  const mergeKey = cacheKey("topic-candidates", {
    kind: "merge",
    candidates: hashJson(candidates),
    prompt: hashJson(mergePrompt),
    model: input.endpoint.model,
  });
  const mergeStart = performance.now();
  let merged = topicsOf(readCache<RawResponse>(input.cacheDir, mergeKey));
  const mergeCacheHit = merged !== undefined;
  if (merged === undefined) {
    logger().info("llm", "提示词版本", {
      promptId: mergeFingerprint.id,
      promptSource: mergeFingerprint.source,
      promptSha256: mergeFingerprint.sha256,
      model: client.model,
      kind: "merge",
      hosts: resolveHostNames(input.transcript.speakers, input.hosts),
    });
    const compact = candidates.map((t) => ({
      title: typeof t.title === "string" ? t.title : "",
      summary: typeof t.summary === "string" ? t.summary : "",
      segments: Array.isArray(t.segments) ? t.segments : [],
    }));
    const text = await client.chat(
      [
        { role: "system", content: mergePrompt },
        {
          role: "user",
          content: `视频共 ${input.chunks.length} 个分块。\n候选主题：\n${JSON.stringify(compact)}`,
        },
      ],
      { json: true },
    );
    merged = requireTopics(parseJsonLoose<RawResponse>(text), text, "主题合并");
    writeCache(input.cacheDir, mergeKey, { topics: merged });
  }
  logger().info("llm", "主题合并", { cacheHit: mergeCacheHit, inputTopicCount: candidates.length, topicCount: merged.length, durationMs: Math.round(performance.now() - mergeStart) });
  const topics = sanitizeTopics(merged, maxEnd);
  if (topics.length === 0) {
    throw new Error(`主题合并失败：${candidates.length} 个候选主题里没有一个带有效时间段`);
  }
  logger().info("llm", "划主题完成", { topics: topics.length, durationMs: Math.round(performance.now() - startedAt), model: client.model });
  return { topics };
}
