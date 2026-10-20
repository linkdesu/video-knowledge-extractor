import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Chunk } from "./video";

const BASE = (process.env.ASR_BASE_URL ?? "http://127.0.0.1:9527/v1").replace(/\/$/, "");
const KEY = process.env.ASR_API_KEY ?? "1234";
const MODEL = process.env.ASR_MODEL ?? "qwen-asr";

export type AsrSegment = { text: string; start: number; end: number };
export type AsrResult = {
  text: string;
  segments: AsrSegment[];
  model: string;
  chunkStart: number;
  chunkEnd: number;
  promptHash?: string;
};

export type CachedAsr = { chunk: Chunk; result: AsrResult; cached: boolean };

async function transcribeOnce(file: string, chunk: Chunk, prompt: string): Promise<AsrResult> {
  const fd = new FormData();
  fd.append("file", Bun.file(file), `chunk_${String(chunk.index).padStart(4, "0")}.wav`);
  fd.append("model", MODEL);
  if (prompt) fd.append("prompt", prompt);
  const res = await fetch(`${BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}` },
    body: fd,
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`ASR HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { text?: string; segments?: { text?: string; start?: number; end?: number }[] };
  const rawSegments = Array.isArray(data.segments) ? data.segments : [];
  const segments = rawSegments
    .map((s) => ({ text: (s.text ?? "").trim(), start: Number(s.start ?? 0), end: Number(s.end ?? 0) }))
    .filter((s) => s.text.length > 0);
  if (segments.length === 0 && data.text?.trim()) {
    segments.push({ text: data.text.trim(), start: 0, end: chunk.end - chunk.start });
  }
  for (const s of segments) {
    s.start = Math.max(0, Math.min(s.start, chunk.end - chunk.start));
    s.end = Math.max(s.start + 0.1, Math.min(s.end, chunk.end - chunk.start));
  }
  return {
    text: (data.text ?? "").trim(),
    segments,
    model: MODEL,
    chunkStart: chunk.start,
    chunkEnd: chunk.end,
    promptHash: prompt ? Bun.hash(prompt).toString(16) : "",
  };
}

/** 转写单个切片；同目录下已有结果直接复用（--force 时由调用方清空）。 */
export async function transcribeChunk(
  audioFile: string,
  chunk: Chunk,
  cacheFile: string,
  prompt = "",
): Promise<CachedAsr> {
  const promptHash = prompt ? Bun.hash(prompt).toString(16) : "";
  if (existsSync(cacheFile)) {
    try {
      const result = JSON.parse(readFileSync(cacheFile, "utf8")) as AsrResult;
      if (
        result?.model === MODEL &&
        Math.abs(result.chunkStart - chunk.start) < 0.01 &&
        (result.promptHash ?? "") === promptHash
      ) {
        return { chunk, result, cached: true };
      }
    } catch {
      // 损坏则重转
    }
  }
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await transcribeOnce(audioFile, chunk, prompt);
      writeFileSync(cacheFile, JSON.stringify(result, null, 1));
      return { chunk, result, cached: false };
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await Bun.sleep(800 * attempt);
    }
  }
  throw new Error(`ASR chunk ${chunk.index} 失败: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}
