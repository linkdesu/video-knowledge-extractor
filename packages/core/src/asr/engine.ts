/**
 * ASR 引擎边界（ADR-0016 §6）：本地 sherpa、OpenAI 兼容远程、火山引擎（极速版/标准版）。
 * 引擎 id 与设置提供方同值（local / openai / volcengine）；旧值 "remote" 只在
 * `video-data` 读取边界映射为 "openai"。`pipeline/transcribe.ts` 的既有调用面走同一接口。
 */
import { createLocalEngine } from "./local";
import { createRemoteEngine, createUrlEngine } from "./remote";
import { createOpenAiProvider } from "./providers/openai";
import { createVolcengineFlashProvider, createVolcengineStandardProvider } from "./providers/volcengine";
import type { VolcengineAuth } from "../core/credentials";
import type { AsrProvider, VolcengineMode } from "../core/settings";
import type { ChunkLimits } from "../core/audio";
import type { Progress } from "../core/steps";
import type { Chunk, Transcript, Video } from "../core/types";

export type AsrEngineId = AsrProvider;

export type AsrConfig =
  | { provider: "local"; modelDir: string }
  | { provider: "openai"; baseUrl: string; model: string; apiKey: string }
  | { provider: "volcengine"; mode: VolcengineMode; auth: VolcengineAuth };

export type AsrInput = {
  video: Video;
  wavPath: string;
  cacheDir: string;
  onProgress?: (p: Progress) => void;
  /** 火山标准版只接受公网 URL；本地转写没有该值。 */
  sourceUrl?: string;
};

export type AsrRun = {
  transcript: Transcript;
  chunks: Chunk[];
  timings: Record<string, number>;
  cacheHits: string[];
  engine: AsrEngineId;
  modelId: string;
};

/** 旧 `transcribeVideo` 的返回形状：本地 `AsrRun` 去掉 `engine`/`modelId`。 */
export type TranscribeRun = Omit<AsrRun, "engine" | "modelId">;

export type AsrEngine = { id: AsrEngineId; modelId: string; run(input: AsrInput): Promise<AsrRun> };

export type AsrEngineOptions = {
  /** 测试注入 mock fetch。 */
  fetchImpl?: typeof fetch;
  /** 测试注入小分块限额，缩短远程请求时长。 */
  chunkLimits?: ChunkLimits;
  /** 块编码实现（默认 ffmpeg 48kbps mp3/aac）；测试可注入桩。火山极速版直接传 WAV，不走编码。 */
  encodeChunk?: (wavPath: string, outPath: string, format: "mp3" | "aac") => Promise<void>;
  /** 火山标准版轮询间隔注入（测试用短间隔）。 */
  pollIntervalMs?: number;
  /** 火山标准版总时长上限注入（测试用短上限）。 */
  standardMaxTotalMs?: number;
};

export function createAsrEngine(config: AsrConfig, opts?: AsrEngineOptions): AsrEngine {
  if (config.provider === "local") return createLocalEngine({ modelDir: config.modelDir });
  if (config.provider === "openai") {
    return createRemoteEngine(
      createOpenAiProvider({ baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey }),
      opts,
    );
  }
  if (config.provider === "volcengine" && config.mode === "standard") {
    return createUrlEngine(
      createVolcengineStandardProvider(config.auth, {
        pollIntervalMs: opts?.pollIntervalMs,
        maxTotalMs: opts?.standardMaxTotalMs,
      }),
      { fetchImpl: opts?.fetchImpl },
    );
  }
  return createRemoteEngine(createVolcengineFlashProvider(config.auth), opts);
}
