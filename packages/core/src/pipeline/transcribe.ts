/**
 * 转写流水线的既有调用面：`transcribeVideo` 保持为本地引擎的薄包装
 * （ADR-0015 §5），引擎实现在 `asr/local.ts`。
 */
import { createAsrEngine, type TranscribeRun } from "../asr/engine";
import type { Progress } from "../core/steps";
import type { Video } from "../core/types";

export async function transcribeVideo(input: {
  video: Video;
  wavPath: string;
  cacheDir: string;
  modelDir: string;
  onProgress?: (p: Progress) => void;
}): Promise<TranscribeRun> {
  const engine = createAsrEngine({ provider: "local", modelDir: input.modelDir });
  const run = await engine.run({
    video: input.video,
    wavPath: input.wavPath,
    cacheDir: input.cacheDir,
    ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
  });
  return { transcript: run.transcript, chunks: run.chunks, timings: run.timings, cacheHits: run.cacheHits };
}
