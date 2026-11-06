/// <reference path="../types/sherpa-onnx-node.d.ts" />
/**
 * 段级说话人嵌入（CAM++）：Lab 验收台与正式本地转写（`local.ts`）共用这一份抽取口径，
 * 二次聚类（`refine.ts`）的输入只能从这里来，避免两套「多短算没嵌入」的定义漂移。
 *
 * 只算时长达标的段；更短的段在 `EmbeddingRow.v` 上留 null，由 `refineSegments` 的
 * 「短段沿用／质心余弦最大」分支处理。
 */
import * as sherpaModule from "sherpa-onnx-node";
import type { EmbeddingRow } from "./refine";

/**
 * 参与嵌入的最短段时长（秒）。0.1 秒是 Lab 自 r48 起的口径（`LAB_EMBED_MIN_SECONDS`），
 * 再短的段 CAM++ 取不到稳定特征。
 */
export const SPEAKER_EMBED_MIN_SECONDS = 0.1;

type SherpaApi = typeof sherpaModule;

/** app.asar 里这个 CJS 包的命名导出不全，`default` 才是完整 module.exports（r26 / r48 实测）。 */
function resolveSherpaApi(mod: unknown): SherpaApi {
  if (typeof mod === "object" && mod !== null && "SpeakerEmbeddingExtractor" in mod) return mod as SherpaApi;
  if (typeof mod === "object" && mod !== null && "default" in mod && typeof mod.default === "object" && mod.default !== null) {
    return mod.default as SherpaApi;
  }
  throw new Error("sherpa-onnx-node 加载失败：没有 SpeakerEmbeddingExtractor");
}

const sherpa = resolveSherpaApi(sherpaModule);

export type SpeakerEmbeddingInput = {
  samples: Float32Array;
  sampleRate: number;
  /** 与嵌入一一对应的分离段（sherpa 原始段，不排序、不过滤）。 */
  segments: ReadonlyArray<{ start: number; end: number }>;
  /** CAM++ 嵌入模型路径（`resolveModelPaths(modelDir).embedding`）。 */
  modelPath: string;
  numThreads?: number;
  /** 每 25 段报一次进度（与 Lab 的节奏一致）。 */
  onProgress?: (done: number, total: number) => void;
};

/**
 * 逐段算嵌入。返回值与 `segments` 等长、顺序一致；短于 `SPEAKER_EMBED_MIN_SECONDS`
 * 或抽取器还没准备好的段是 `{ v: null }`。
 */
export function extractSegmentEmbeddings(input: SpeakerEmbeddingInput): EmbeddingRow[] {
  const extractor = new sherpa.SpeakerEmbeddingExtractor({
    model: input.modelPath,
    numThreads: input.numThreads ?? 2,
    debug: 0,
    provider: "cpu",
  });
  const rows: EmbeddingRow[] = [];
  const total = input.segments.length;
  input.segments.forEach((segment, index) => {
    const from = Math.max(0, Math.round(segment.start * input.sampleRate));
    const to = Math.min(input.samples.length, Math.round(segment.end * input.sampleRate));
    let vector: number[] | null = null;
    if (segment.end - segment.start >= SPEAKER_EMBED_MIN_SECONDS && to > from) {
      const stream = extractor.createStream();
      stream.acceptWaveform({ samples: input.samples.subarray(from, to), sampleRate: input.sampleRate });
      // Electron utility process 禁止 napi 外部缓冲（enableExternalBuffer 默认 true 会抛错）。
      if (extractor.isReady(stream)) vector = Array.from(extractor.compute(stream, false));
    }
    rows.push({ start: segment.start, end: segment.end, v: vector });
    if (input.onProgress !== undefined && index % 25 === 0) input.onProgress(index + 1, total);
  });
  if (input.onProgress !== undefined && total > 0) input.onProgress(total, total);
  return rows;
}
