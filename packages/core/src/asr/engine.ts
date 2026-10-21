/**
 * ASR 引擎边界（ADR-0015 §5）：本地 sherpa 与 OpenAI 兼容远程两种实现，
 * `pipeline/transcribe.ts` 的既有调用面通过这里的工厂走同一接口。
 */
import { createLocalEngine } from "./local";
import { createRemoteEngine } from "./remote";
import type { ChunkLimits } from "../core/audio";
import type { Progress } from "../core/steps";
import type { Chunk, Transcript, Video } from "../core/types";

export type AsrEngineId = "local" | "remote";

export type AsrConfig =
  | { provider: "local"; modelDir: string }
  | { provider: "remote"; baseUrl: string; model: string; apiKey: string };

export type AsrInput = {
  video: Video;
  wavPath: string;
  cacheDir: string;
  onProgress?: (p: Progress) => void;
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
  /** 块编码实现（默认 ffmpeg 48kbps mp3/aac）；测试可注入桩。 */
  encodeChunk?: (wavPath: string, outPath: string, format: "mp3" | "aac") => Promise<void>;
};

export function createAsrEngine(config: AsrConfig, opts?: AsrEngineOptions): AsrEngine {
  if (config.provider === "local") return createLocalEngine({ modelDir: config.modelDir });
  return createRemoteEngine(
    { baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey },
    opts,
  );
}
