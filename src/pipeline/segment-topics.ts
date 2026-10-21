import { cacheKey, hashJson, readCache, writeCache } from "../core/cache";
import { createLlmClient, parseJsonLoose } from "../llm/openai";
import type { SegmentTopicsInput, SegmentTopicsResult } from "../core/steps";
import type { Segment, Topic, TopicId } from "../core/types";

type RawTopic = {
  title?: unknown;
  summary?: unknown;
  segments?: unknown;
};

type RawResponse = { topics?: RawTopic[] };

const CHUNK_SYSTEM_PROMPT =
  "你是视频主题分析器。只输出 JSON，不要解释。" +
  "只使用给出的时间戳，每个时间段必须落在该块范围内。" +
  "主题数 1-4，title 不超过 20 字，summary 不超过 60 字。" +
  '输出格式：{"topics":[{"title":string,"summary":string,"segments":[{"start":number,"end":number}]}]}';

const MERGE_SYSTEM_PROMPT =
  "你是视频主题分析器。只输出 JSON，不要解释。" +
  "给出的是各分块的候选主题，把跨块属于同一主题的候选合并成一个主题，保留多个时间段。" +
  "只使用给出的时间戳。" +
  '输出格式：{"topics":[{"title":string,"summary":string,"segments":[{"start":number,"end":number}]}]}';

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
  const chunkPromptHash = hashJson(CHUNK_SYSTEM_PROMPT);

  for (let i = 0; i < input.chunks.length; i++) {
    const chunk = input.chunks[i];
    if (chunk === undefined) continue;
    const lines = renderChunkLines(input, i);
    if (lines.length > 0) {
      const key = cacheKey("topic-candidates", {
        chunk: hashJson(lines),
        prompt: chunkPromptHash,
        model: input.endpoint.model,
      });
      let raw: RawResponse | undefined = readCache<RawResponse>(input.cacheDir, key);
      if (raw === undefined) {
        const text = await client.chat([
          { role: "system", content: CHUNK_SYSTEM_PROMPT },
          { role: "user", content: `该块范围 [${chunk.start}-${chunk.end}]：\n${lines.join("\n")}` },
        ], { json: true });
        raw = parseJsonLoose<RawResponse>(text);
        writeCache(input.cacheDir, key, raw);
      }
      candidates.push(...(Array.isArray(raw.topics) ? raw.topics : []));
    }
    input.onProgress?.({ step: "segment-topics", done: i + 1, total: input.chunks.length });
  }
  if (candidates.length === 0) return { topics: [] };

  const mergeKey = cacheKey("topic-candidates", {
    kind: "merge",
    candidates: hashJson(candidates),
    prompt: hashJson(MERGE_SYSTEM_PROMPT),
    model: input.endpoint.model,
  });
  let merged: RawResponse | undefined = readCache<RawResponse>(input.cacheDir, mergeKey);
  if (merged === undefined) {
    const compact = candidates.map((t) => ({
      title: typeof t.title === "string" ? t.title : "",
      summary: typeof t.summary === "string" ? t.summary : "",
      segments: Array.isArray(t.segments) ? t.segments : [],
    }));
    const text = await client.chat(
      [
        { role: "system", content: MERGE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `视频共 ${input.chunks.length} 个分块。\n候选主题：\n${JSON.stringify(compact)}`,
        },
      ],
      { json: true },
    );
    merged = parseJsonLoose<RawResponse>(text);
    writeCache(input.cacheDir, mergeKey, merged);
  }

  return { topics: sanitizeTopics(merged.topics ?? [], maxEnd) };
}
