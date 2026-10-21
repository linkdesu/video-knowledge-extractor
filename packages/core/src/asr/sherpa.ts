/// <reference path="../types/sherpa-onnx-node.d.ts" />
import { existsSync } from "node:fs";
import * as sherpa from "sherpa-onnx-node";

const ASR_SAMPLE_RATE = 16000;

const DEFAULT_NUM_THREADS = 4;

// pipeline 的分离缓存键从这里取值，避免模型配置与键漂移。
export const DIARIZATION_TUNING = {
  windowShiftRatio: 0.1,
  threshold: 0.85,
  minDurationOn: 0.25,
  minDurationOff: 0.5,
} as const;

// 解码每段时前后各多取的秒数，给 CTC 上下文，不改变时间戳。
export const ASR_PADDING_SECONDS = 0.2;

export type SherpaPaths = {
  fireredModel: string;
  fireredTokens: string;
  segmentation: string;
  embedding: string;
  punctuation: string;
};

export function resolveModelPaths(modelDir: string): SherpaPaths {
  const paths: SherpaPaths = {
    fireredModel: `${modelDir}/sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25/model.int8.onnx`,
    fireredTokens: `${modelDir}/sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25/tokens.txt`,
    segmentation: `${modelDir}/sherpa-onnx-pyannote-segmentation-3-0/model.onnx`,
    embedding: `${modelDir}/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`,
    punctuation: `${modelDir}/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12/model.onnx`,
  };
  for (const [name, p] of Object.entries(paths)) {
    if (!existsSync(p)) throw new Error(`缺少模型文件：${name}（${p}）`);
  }
  return paths;
}

export type DiarizationSegment = { start: number; end: number; speaker: number };

export type Transcriber = {
  sampleRate: number;
  diarize(samples: Float32Array): DiarizationSegment[];
  decode(samples: Float32Array): string;
};

function withPunct(punct: sherpa.OfflinePunctuation, raw: string): string {
  if (!raw) return "";
  // FireRed CTC 输出没有标点；
  if (/[，。！？；：]/.test(raw)) return raw;
  try {
    return punct.addPunct(raw).trim();
  } catch {
    return raw;
  }
}

export function createTranscriber(paths: SherpaPaths, opts?: { numThreads?: number }): Transcriber {
  const numThreads = opts?.numThreads ?? DEFAULT_NUM_THREADS;
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: ASR_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      fireRedAsrCtc: { model: paths.fireredModel },
      tokens: paths.fireredTokens,
      numThreads,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
  });
  const punct = new sherpa.OfflinePunctuation({
    model: { ctTransformer: paths.punctuation, numThreads: 1, provider: "cpu" },
  });
  const diarizer = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: paths.segmentation, windowShiftRatio: DIARIZATION_TUNING.windowShiftRatio } },
    embedding: { model: paths.embedding, numThreads: 2 },
    clustering: { numClusters: -1, threshold: DIARIZATION_TUNING.threshold },
    minDurationOn: DIARIZATION_TUNING.minDurationOn,
    minDurationOff: DIARIZATION_TUNING.minDurationOff,
  });
  return {
    sampleRate: ASR_SAMPLE_RATE,
    diarize(samples) {
      return diarizer.process(samples);
    },
    decode(samples) {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: ASR_SAMPLE_RATE });
      recognizer.decode(stream);
      return withPunct(punct, (recognizer.getResult(stream).text ?? "").trim());
    },
  };
}

export { readWav } from "../core/wav";
