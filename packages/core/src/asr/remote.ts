/**
 * 远程 ASR 引擎（ADR-0015 §5）：OpenAI 兼容 `POST <baseUrl>/audio/transcriptions`。
 * 块切分用 `hardMax`（绝不发出超时长请求）；逐块缓存只存块内相对时间；
 * 无说话人分离，全部字幕归 `speaker-1`。
 */
import { readFile } from "node:fs/promises";
import { detectSilences, planChunks, sliceWav, type ChunkLimits } from "../core/audio";
import { cacheKey, readCache, sha256, writeCache } from "../core/cache";
import { run } from "../core/exec";
import { redact } from "../llm/openai";
import { readWav } from "../core/wav";
import type { Speaker, SpeakerId, Utterance } from "../core/types";
import type { AsrInput, AsrRun } from "./engine";

/** 远程分块限额（ADR-0015 §5）：窗口内没有停顿就在 300 秒硬切。 */
export const REMOTE_CHUNK_LIMITS: ChunkLimits = { target: 280, min: 240, max: 300, hardMax: true };

/** 适配器版本：变更块编码/请求/校验语义时递增，使旧缓存失效。 */
export const REMOTE_ADAPTER_VERSION = 1;

const SINGLE_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_000;

export type RemoteCodec = { format: "mp3" | "aac"; ext: string };

/** ffmpeg 是否支持该音频编码：`-encoders` 列表打在 stdout（stderr 无清单）。 */
export async function probeEncoder(codec: string): Promise<boolean> {
  const { stdout, stderr } = await run(["ffmpeg", "-hide_banner", "-encoders"], { label: "探测编码器", allowFail: true });
  return (stdout + "\n" + stderr).split("\n").some((line) => line.includes(codec));
}

/** 启动时探测 libmp3lame；缺失退 aac（.m4a）；两者都不可用报明确错误。 */
export async function detectCodec(probe: typeof probeEncoder = probeEncoder): Promise<RemoteCodec> {
  if (await probe("libmp3lame")) return { format: "mp3", ext: "mp3" };
  if (await probe("aac")) return { format: "aac", ext: "m4a" };
  throw new Error("ffmpeg 不支持 mp3 或 aac 编码，无法上传远程 ASR");
}

/** 48 kbps 转码：mp3（libmp3lame）或 aac（.m4a）。 */
export async function encodeChunkAudio(wavPath: string, outPath: string, codec: RemoteCodec): Promise<void> {
  const codecArg = codec.format === "mp3" ? "libmp3lame" : "aac";
  await run(
    ["ffmpeg", "-y", "-i", wavPath, "-vn", "-b:a", "48k", "-c:a", codecArg, outPath],
    { label: `转 ${codec.ext} ${wavPath}` },
  );
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** 规范化端点：origin+pathname（query 在设置校验时已禁止，这里兜底剥掉）。 */
export function normalizeBaseUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/**
 * 校验并规整端点返回的 segments：有限数字、越界钳制到 [0, 块时长+0.5]、
 * 零长与空文本丢弃、按起点排序。
 */
export function sanitizeSegments(
  raw: unknown,
  chunkDuration: number,
): { start: number; end: number; text: string }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("segments 不是数组");
  const limit = chunkDuration + 0.5;
  const out: { start: number; end: number; text: string }[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) throw new Error("segment 不是对象");
    const rec = item as Record<string, unknown>;
    const start = Number(rec.start);
    const end = Number(rec.end);
    const text = typeof rec.text === "string" ? rec.text.trim() : "";
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("segment 时间不是有限数字");
    const s = Math.min(Math.max(start, 0), limit);
    const e = Math.min(Math.max(end, 0), limit);
    if (s >= e || text === "") continue;
    out.push({ start: s, end: e, text });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

async function uploadChunk(
  fileBytes: Uint8Array,
  fileName: string,
  opts: { url: string; apiKey: string; model: string; fetchImpl: typeof fetch },
): Promise<{ text?: unknown; segments?: unknown }> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(fileBytes)], { type: "audio/mpeg" }), fileName);
    form.append("model", opts.model);
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
    form.append("language", "zh");
    try {
      const res = await opts.fetchImpl(opts.url, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(SINGLE_TIMEOUT_MS),
      });
      const bodyText = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(bodyText) as { text?: unknown; segments?: unknown };
        } catch {
          throw new Error(`远程 ASR 返回了非 JSON 响应：${redact(bodyText.slice(0, 300), opts.apiKey)}`);
        }
      }
      // 429/5xx 才重试；401/403/413 与其余状态直接抛出。
      const retriable = res.status === 429 || res.status >= 500;
      lastErr = new Error(`远程 ASR 返回 HTTP ${res.status}：${redact(bodyText.slice(-300), opts.apiKey)}`);
      if (!retriable) throw lastErr;
      if (attempt === MAX_ATTEMPTS) throw lastErr;
      await sleep(RETRY_DELAY_MS);
    } catch (err) {
      if (isAbortError(err)) {
        lastErr = new Error(`远程 ASR 请求超时（${SINGLE_TIMEOUT_MS / 1000}s）`);
        if (attempt === MAX_ATTEMPTS) throw lastErr;
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      if (err instanceof TypeError) {
        // fetch 网络错误（连接失败等）
        lastErr = new Error(`远程 ASR 网络错误：${(err as Error).message}`);
        if (attempt === MAX_ATTEMPTS) throw lastErr;
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("远程 ASR 重试耗尽");
}

export type RemoteAsrConfig = { baseUrl: string; model: string; apiKey: string };

export type RemoteEngineOptions = {
  fetchImpl?: typeof fetch;
  chunkLimits?: ChunkLimits;
  /** 测试注入桩；缺省用 ffmpeg 探测 + 48kbps 转码。 */
  encodeChunk?: (wavPath: string, outPath: string, format: "mp3" | "aac") => Promise<void>;
};

export function createRemoteEngine(config: RemoteAsrConfig, opts?: RemoteEngineOptions): {
  id: "remote";
  modelId: string;
  run(input: AsrInput): Promise<AsrRun>;
} {
  const doFetch = opts?.fetchImpl ?? fetch;
  const limits = opts?.chunkLimits ?? REMOTE_CHUNK_LIMITS;
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const url = `${baseUrl}/audio/transcriptions`;
  const cacheBase = {
    kind: "remote-chunk",
    engine: "remote",
    adapter: REMOTE_ADAPTER_VERSION,
    model: config.model,
    baseUrl,
    responseFormat: "verbose_json",
  };

  return {
    id: "remote",
    modelId: config.model,
    async run(input: AsrInput): Promise<AsrRun> {
      const timings: Record<string, number> = {};
      const cacheHits: string[] = [];
      const t = (ms: number) => Math.round(ms / 10) / 100;
      const t0 = performance.now();

      const { samples, sampleRate } = readWav(input.wavPath);
      timings.readWave = t(performance.now() - t0);
      if (sampleRate !== 16000) throw new Error(`wav 采样率必须是 16000，实际 ${sampleRate}（${input.wavPath}）`);
      const duration = samples.length / sampleRate;

      const s0 = performance.now();
      const silences = await detectSilences(input.wavPath);
      timings.silence = t(performance.now() - s0);
      const chunks = planChunks(duration, silences, limits);

      const codec = opts?.encodeChunk !== undefined ? { format: "mp3" as const, ext: "mp3" } : await detectCodec();
      const encode = (wavPath: string, outPath: string, format: "mp3" | "aac") =>
        opts?.encodeChunk !== undefined
          ? opts.encodeChunk(wavPath, outPath, format)
          : encodeChunkAudio(wavPath, outPath, format === "mp3" ? { format: "mp3", ext: "mp3" } : { format: "aac", ext: "m4a" });

      let done = 0;
      const reportProgress = () => {
        done += 1;
        input.onProgress?.({ step: "transcribe", done, total: chunks.length, detail: `远程块 ${done}/${chunks.length}` });
      };

      const speaker: Speaker = {
        id: "speaker-1" as SpeakerId,
        name: "说话人1",
        color: "#6aa9ff",
      };
      const utterances: Utterance[] = [];

      const r0 = performance.now();
      for (const chunk of chunks) {
        const from = Math.max(0, Math.round(chunk.start * sampleRate));
        const to = Math.min(samples.length, Math.round(chunk.end * sampleRate));
        const chunkBytes = new Uint8Array(samples.buffer, samples.byteOffset + from * 4, (to - from) * 4);
        const key = cacheKey("transcribe", {
          ...cacheBase,
          audio: sha256(chunkBytes),
          codec: codec.format,
        });
        const cached = readCache<{ segments: { start: number; end: number; text: string }[] }>(input.cacheDir, key);
        if (cached !== undefined) {
          cacheHits.push(`chunk-${chunk.index}`);
          for (const s of cached.segments) utterances.push({ ...s, start: chunk.start + s.start, end: chunk.start + s.end, speakerId: speaker.id });
          reportProgress();
          continue;
        }

        const wavOut = `${input.cacheDir}/remote-chunk-${chunk.index}.wav`;
        await sliceWav(input.wavPath, chunk.start, chunk.end, wavOut);
        const audioOut = `${wavOut}.${codec.ext}`;
        try {
          await encode(wavOut, audioOut, codec.format);
          const fileBytes = new Uint8Array(await readFile(audioOut));
          const res = await uploadChunk(fileBytes, `chunk-${chunk.index}.${codec.ext}`, {
            url,
            apiKey: config.apiKey,
            model: config.model,
            fetchImpl: doFetch,
          });
          const chunkDuration = chunk.end - chunk.start;
          const hasText = typeof res.text === "string" && res.text.trim() !== "";
          const segments = sanitizeSegments(res.segments, chunkDuration);
          if (segments.length === 0) {
            if (!hasText) {
              // 整块静音：合法空结果。
              writeCache(input.cacheDir, key, { segments: [] });
              reportProgress();
              continue;
            }
            throw new Error("该端点不返回逐句时间戳，不能用于字幕");
          }
          writeCache(input.cacheDir, key, { segments });
          for (const s of segments) utterances.push({ ...s, start: chunk.start + s.start, end: chunk.start + s.end, speakerId: speaker.id });
          reportProgress();
        } finally {
          await removeQuiet(wavOut);
          await removeQuiet(audioOut);
        }
      }
      timings.remote = t(performance.now() - r0);

      // 块之间不按文本去重：相同短句在边界两侧各自可能是真实语音（ADR-0015）。
      utterances.sort((a, b) => a.start - b.start);
      timings.total = t(performance.now() - t0);
      return {
        transcript: { speakers: [speaker], utterances },
        chunks,
        timings,
        cacheHits,
        engine: "remote",
        modelId: config.model,
      };
    },
  };
}

async function removeQuiet(path: string): Promise<void> {
  try {
    await Bun.file(path).delete();
  } catch {
    // 文件不存在时无所谓
  }
}
