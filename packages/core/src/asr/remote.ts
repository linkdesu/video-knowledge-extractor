/**
 * 远程 ASR 的共享分块管线（ADR-0016 §6）：
 * 读 WAV、静音检测、`planChunks`、切片、可选转码、逐块缓存、重试节奏、时间偏移、
 * 进度、单说话人组装。协议全部在 `providers/`（OpenAI 兼容 / 火山引擎）。
 * 块切分用 `hardMax`（绝不发出超时长请求）；逐块缓存只存块内相对时间；
 * 无说话人分离，全部字幕归 `speaker-1`。
 */
import { readFile } from "node:fs/promises";
import { detectSilences, planChunks, sliceWav, type ChunkLimits } from "../core/audio";
import { cacheKey, readCache, sha256, writeCache } from "../core/cache";
import { run } from "../core/exec";
import { readWav } from "../core/wav";
import type { Speaker, SpeakerId, Utterance } from "../core/types";
import type { AsrEngine, AsrInput, AsrRun } from "./engine";

/** 远程分块限额（ADR-0016 §8）：窗口内没有停顿就在 300 秒硬切。 */
export const REMOTE_CHUNK_LIMITS: ChunkLimits = { target: 280, min: 240, max: 300, hardMax: true };

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

/** 块内相对时间（秒）的段：缓存只存这个形状，命中后与实时响应走同一条「加块起点」路径。 */
export type RemoteSegment = { start: number; end: number; text: string };

/** 一次请求用到的音频：编码后的字节、文件名、格式与块时长。 */
export type RemoteChunkAudio = {
  bytes: Uint8Array;
  fileName: string;
  format: "mp3" | "m4a" | "wav";
  duration: number;
};

/** 协议适配器（ADR-0016 §6）：发一次块请求，返回块内相对时间；重试由本管线驱动。 */
export type RemoteProvider = {
  id: "openai" | "volcengine-flash";
  modelId: string;
  adapterVersion: number;
  /** 参与缓存键的提供方常量（端点、resource id、response format 等）。 */
  cache: Record<string, string | number>;
  /** "mp3" 走 detectCodec 的 mp3/aac 回退；"wav" 直接上传 16k 单声道 PCM。 */
  audio: "mp3" | "wav";
  timeoutMs: number;
  /** 缺省表示不额外检查；火山极速版设为 20 MiB。 */
  maxUploadBytes?: number;
  transcribe(chunk: RemoteChunkAudio, fetchImpl: typeof fetch): Promise<RemoteTranscribeResult>;
};

/** 标准版适配器（ADR-0016 §6）：只收公网 URL，返回整段绝对时间。 */
export type UrlProvider = {
  id: "volcengine-standard";
  modelId: string;
  adapterVersion: number;
  cache: Record<string, string | number>;
  transcribeUrl(url: string, fetchImpl: typeof fetch, onPoll?: (attempt: number) => void): Promise<{
    segments: RemoteSegment[];
    duration: number;
  }>;
};

/** 协议适配器的结果：`segments` 是块内相对时间；`rawText` 仅供「整块静音」判定（ADR-0015 语义）。 */
export type RemoteTranscribeResult = { segments: RemoteSegment[]; rawText?: unknown };

/** 可重试性由共享管线判定的错误：429/5xx、550xxxx、超时、网络错误为 true。 */
export class RemoteAsrError extends Error {
  constructor(message: string, readonly retriable: boolean) {
    super(message);
  }
}

/**
 * 校验并规整端点返回的 segments：有限数字、越界钳制到 [0, 块时长+0.5]、
 * 零长与空文本丢弃、按起点排序。
 */
export function sanitizeSegments(
  raw: unknown,
  chunkDuration: number,
): RemoteSegment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("segments 不是数组");
  const limit = chunkDuration + 0.5;
  const out: RemoteSegment[] = [];
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

export type RemoteEngineOptions = {
  fetchImpl?: typeof fetch;
  chunkLimits?: ChunkLimits;
  /** 测试注入桩；缺省用 ffmpeg 探测 + 48kbps 转码。火山极速版 audio 为 "wav" 时不调用。 */
  encodeChunk?: (wavPath: string, outPath: string, format: "mp3" | "aac") => Promise<void>;
};

/**
 * 共享分块管线：读 WAV → 静音检测 → 分块 → 切片（可选转码）→ 逐块缓存与重试 →
 * 时间偏移 → 单说话人组装。`provider.audio` 为 "wav" 时直接传 PCM（火山极速版），
 * 否则按 detectCodec 结果转码（OpenAI 分支）。
 */
export function createRemoteEngine(provider: RemoteProvider, opts?: RemoteEngineOptions): AsrEngine {
  const doFetch = opts?.fetchImpl ?? fetch;
  const limits = opts?.chunkLimits ?? REMOTE_CHUNK_LIMITS;
  const cacheBase = {
    kind: "remote-chunk",
    provider: provider.id,
    adapter: provider.adapterVersion,
    model: provider.modelId,
    ...provider.cache,
  };

  return {
    id: provider.id === "openai" ? "openai" : "volcengine",
    modelId: provider.modelId,
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

      let codec: RemoteCodec;
      if (provider.audio === "mp3") {
        codec = opts?.encodeChunk !== undefined ? { format: "mp3", ext: "mp3" } : await detectCodec();
      } else {
        codec = { format: "mp3", ext: "mp3" }; // 占位，wav 路径不使用
      }
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
          codec: provider.audio === "wav" ? "wav" : codec.format,
        });
        const cached = readCache<{ segments: RemoteSegment[] }>(input.cacheDir, key);
        if (cached !== undefined) {
          cacheHits.push(`chunk-${chunk.index}`);
          for (const s of cached.segments) {
            utterances.push({ ...s, start: chunk.start + s.start, end: chunk.start + s.end, speakerId: speaker.id });
          }
          reportProgress();
          continue;
        }

        const chunkDuration = chunk.end - chunk.start;
        const wavOut = `${input.cacheDir}/remote-chunk-${chunk.index}.wav`;
        await sliceWav(input.wavPath, chunk.start, chunk.end, wavOut);
        let audioBytes: Uint8Array;
        let fileName: string;
        let format: RemoteChunkAudio["format"];
        if (provider.audio === "wav") {
          // 火山极速版：直接传 16k 单声道 PCM WAV（切片即 16k/16bit/单声道，ADR-0016 §8）。
          audioBytes = new Uint8Array(await readFile(wavOut));
          fileName = `chunk-${chunk.index}.wav`;
          format = "wav";
        } else {
          const audioOut = `${wavOut}.${codec.ext}`;
          await encode(wavOut, audioOut, codec.format);
          audioBytes = new Uint8Array(await readFile(audioOut));
          fileName = `chunk-${chunk.index}.${codec.ext}`;
          format = codec.format === "mp3" ? "mp3" : "m4a";
        }
        if (provider.maxUploadBytes !== undefined && audioBytes.byteLength > provider.maxUploadBytes) {
          throw new RemoteAsrError(
            `块 ${chunk.index} 的原始字节数 ${audioBytes.byteLength} 超过提供方单次上限 ${provider.maxUploadBytes} 字节`,
            false,
          );
        }
        let lastErr: RemoteAsrError | undefined;
        let lastRetriable = false;
        let ok = false;
        let result: RemoteTranscribeResult | undefined;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !ok; attempt += 1) {
          try {
            result = await provider.transcribe({ bytes: audioBytes, fileName, format, duration: chunkDuration }, doFetch);
            ok = true;
          } catch (err) {
            if (err instanceof RemoteAsrError) {
              lastErr = err;
              lastRetriable = err.retriable;
            } else if (isAbortError(err)) {
              lastErr = new RemoteAsrError(`远程 ASR 请求超时（${provider.timeoutMs / 1000}s）`, true);
              lastRetriable = true;
            } else if (err instanceof TypeError) {
              lastErr = new RemoteAsrError(`远程 ASR 网络错误：${err.message}`, true);
              lastRetriable = true;
            } else {
              throw err;
            }
            if (!lastRetriable || attempt === MAX_ATTEMPTS) break;
            await sleep(RETRY_DELAY_MS);
          }
        }
        if (!ok || result === undefined) throw lastErr ?? new Error("远程 ASR 请求失败");
        const segments = result.segments;
        if (segments.length === 0) {
          const rawText = result.rawText;
          if (typeof rawText !== "string" || rawText.trim() === "") {
            // 整块静音：合法空结果，写空缓存。
            writeCache(input.cacheDir, key, { segments: [] });
            reportProgress();
            continue;
          }
          // 适配器已判定「text 非空但没有逐句时间戳」时直接抛错，不写缓存。
          throw new Error("该端点不返回逐句时间戳，不能用于字幕");
        }
        writeCache(input.cacheDir, key, { segments });
        for (const s of segments) {
          utterances.push({ ...s, start: chunk.start + s.start, end: chunk.start + s.end, speakerId: speaker.id });
        }
        reportProgress();
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
        engine: provider.id === "openai" ? "openai" : "volcengine",
        modelId: provider.modelId,
      };
    },
  };
}

/**
 * 标准版引擎（ADR-0016 §6）：不读 WAV、不分块；缺 sourceUrl 立即报错；
 * 结果按 audio_info.duration 构造单个 chunk [{index:1, start:0, end:duration}]，
 * 绝对时间不再叠加块偏移；不做跨调用内容缓存（URL 不是内容身份）。
 */
export function createUrlEngine(provider: UrlProvider, opts?: { fetchImpl?: typeof fetch }): AsrEngine {
  const doFetch = opts?.fetchImpl ?? fetch;
  return {
    id: "volcengine",
    modelId: provider.modelId,
    async run(input: AsrInput): Promise<AsrRun> {
      if (input.sourceUrl === undefined || input.sourceUrl.trim() === "") {
        throw new Error("火山标准版只接受公网 URL；本地视频请改用极速版或本地 ASR");
      }
      const t = (ms: number) => Math.round(ms / 10) / 100;
      const t0 = performance.now();
      const { segments, duration } = await provider.transcribeUrl(input.sourceUrl, doFetch, (attempt) => {
        input.onProgress?.({ step: "transcribe", done: 0, total: 1, detail: `火山标准版轮询 ${attempt}` });
      });
      const timings: Record<string, number> = {};
      const speaker: Speaker = {
        id: "speaker-1" as SpeakerId,
        name: "说话人1",
        color: "#6aa9ff",
      };
      const utterances: Utterance[] = segments.map((s) => ({ ...s, speakerId: speaker.id }));
      utterances.sort((a, b) => a.start - b.start);
      timings.total = t(performance.now() - t0);
      input.onProgress?.({ step: "transcribe", done: 1, total: 1, detail: "火山标准版完成" });
      return {
        transcript: { speakers: [speaker], utterances },
        chunks: [{ index: 1, start: 0, end: duration }],
        timings,
        cacheHits: [],
        engine: "volcengine",
        modelId: provider.modelId,
      };
    },
  };
}
