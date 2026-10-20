import * as sherpa from "sherpa-onnx-node";
import type { AsrAdapter, AsrOptions, AsrRun, AsrUtterance } from "./types";
import { applyGlossary } from "../glossary";

type SherpaSegment = { start: number; end: number; speaker: number };
type SherpaWave = { samples: Float32Array; sampleRate: number };
type SherpaRecognizer = {
  createStream(hotwords?: string): {
    acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
  };
  decode(stream: unknown): void;
  getResult(stream: unknown): { text?: string };
};
type SherpaDiarizer = {
  sampleRate: number;
  process(samples: Float32Array): SherpaSegment[];
};

const api = sherpa as unknown as {
  OfflineRecognizer: new (config: unknown) => SherpaRecognizer;
  OfflineSpeakerDiarization: new (config: unknown) => SherpaDiarizer;
  readWave: (path: string) => SherpaWave;
  OfflinePunctuation: new (config: unknown) => { addPunct(text: string): string };
  version: string;
};

export type SherpaModelPaths = {
  paraformer: string;
  paraformerTokens: string;
  zipformerEncoder: string;
  zipformerDecoder: string;
  zipformerJoiner: string;
  zipformerTokens: string;
  zipformerBpe: string;
  segmentation: string;
  embedding: string;
  punctuation: string;
};

export type SherpaAdapterOptions = {
  mode?: "paraformer" | "zipformer";
  numClusters?: number;
  paths?: SherpaModelPaths;
};

export function sherpaPathsFromEnv(): SherpaModelPaths {
  const root = process.env.SHERPA_MODEL_ROOT ?? `${process.env.HOME}/.cache/video-notes/models`;
  return {
    paraformer: process.env.SHERPA_PARAFORMER_MODEL ?? `${root}/sherpa-onnx-paraformer-zh-2024-03-09/model.int8.onnx`,
    paraformerTokens: process.env.SHERPA_TOKENS ?? `${root}/sherpa-onnx-paraformer-zh-2024-03-09/tokens.txt`,
    zipformerEncoder: `${root}/sherpa-onnx-zipformer-multi-zh-hans-2023-9-2/encoder-epoch-20-avg-1.int8.onnx`,
    zipformerDecoder: `${root}/sherpa-onnx-zipformer-multi-zh-hans-2023-9-2/decoder-epoch-20-avg-1.int8.onnx`,
    zipformerJoiner: `${root}/sherpa-onnx-zipformer-multi-zh-hans-2023-9-2/joiner-epoch-20-avg-1.int8.onnx`,
    zipformerTokens: `${root}/sherpa-onnx-zipformer-multi-zh-hans-2023-9-2/tokens.txt`,
    zipformerBpe: `${root}/sherpa-onnx-zipformer-multi-zh-hans-2023-9-2/bpe.vocab`,
    segmentation: process.env.SHERPA_SEGMENTATION_MODEL ?? `${root}/sherpa-onnx-pyannote-segmentation-3-0/model.onnx`,
    embedding: process.env.SHERPA_EMBEDDING_MODEL ?? `${root}/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`,
    punctuation: process.env.SHERPA_PUNCT_MODEL ?? `${root}/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12/model.onnx`,
  };
}

/** 合并同一说话人的相邻片段，控制单段长度，减少识别调用。 */
export function buildUtterances(segments: SherpaSegment[], maxSeconds = 20, maxGap = 0.6): { start: number; end: number; speaker: number }[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number; speaker: number }[] = [];
  for (const s of sorted) {
    if (s.end - s.start < 0.2) continue;
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.speaker === s.speaker &&
      s.start - prev.end <= maxGap &&
      s.end - prev.start <= maxSeconds
    ) {
      prev.end = Math.max(prev.end, s.end);
      continue;
    }
    out.push({ start: s.start, end: s.end, speaker: s.speaker });
  }
  return out;
}

/** 把总时长过短的聚类并到时间最近的相邻说话人，并按总时长重排 S1..Sn。 */
export function cleanupSpeakers(
  utterances: AsrUtterance[],
  minSeconds = 3,
): { utterances: AsrUtterance[]; length: number } {
  const totals = new Map<string, number>();
  for (const u of utterances) totals.set(u.speaker, (totals.get(u.speaker) ?? 0) + (u.end - u.start));
  const big = new Set([...totals].filter(([, s]) => s >= minSeconds).map(([id]) => id));
  if (big.size === 0) return { utterances, length: totals.size };
  const mapped = utterances.map((u) => {
    if (big.has(u.speaker)) return { ...u };
    let prev: AsrUtterance | null = null;
    let next: AsrUtterance | null = null;
    for (const o of utterances) {
      if (o === u || !big.has(o.speaker)) continue;
      if (o.end <= u.start + 0.01) prev = o;
      else if (o.start >= u.end - 0.01 && !next) next = o;
    }
    const prevGap = prev ? u.start - prev.end : Infinity;
    const nextGap = next ? next.start - u.end : Infinity;
    const target = prevGap <= nextGap ? prev : next;
    return target ? { ...u, speaker: target.speaker } : { ...u };
  });
  const order = [...totals].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const names = new Map(order.map((id, i) => [id, `S${i + 1}`]));
  return {
    utterances: mapped.map((u) => ({ ...u, speaker: names.get(u.speaker) ?? u.speaker })),
    length: new Set(mapped.map((u) => u.speaker)).size,
  };
}

export class SherpaAdapter implements AsrAdapter {
  id = "sherpa";
  model: string;
  capabilities = { hotwords: false, diarization: true };
  private mode: "paraformer" | "zipformer";
  private numClusters: number;

  constructor(options: SherpaAdapterOptions = {}) {
    this.mode = options.mode ?? (process.env.SHERPA_ASR_MODE === "zipformer" ? "zipformer" : "paraformer");
    this.numClusters = options.numClusters ?? Number(process.env.SHERPA_NUM_CLUSTERS ?? -1);
    this.paths = options.paths ?? sherpaPathsFromEnv();
    this.model = this.mode === "zipformer"
      ? "zipformer-multi-zh-hans-2023-9-2 + pyannote-segmentation-3.0 + CAM++ zh"
      : "paraformer-zh-2024-03-09 + pyannote-segmentation-3.0 + CAM++ zh";
    this.capabilities.hotwords = this.mode === "zipformer";
  }

  private paths: SherpaModelPaths;

  async transcribe(audioPath: string, options: AsrOptions = {}): Promise<AsrRun> {
    const notes: string[] = [];
    const timings: Record<string, number> = {};
    let t0 = performance.now();
    const wave = api.readWave(audioPath);
    timings.readWave = (performance.now() - t0) / 1000;
    const limit = options.limit ?? wave.samples.length / wave.sampleRate;
    const samples = limit * wave.sampleRate < wave.samples.length
      ? wave.samples.subarray(0, Math.floor(limit * wave.sampleRate))
      : wave.samples;
    t0 = performance.now();
    const diarizer = new api.OfflineSpeakerDiarization({
      segmentation: { pyannote: { model: this.paths.segmentation, windowShiftRatio: 0.1 } },
      embedding: { model: this.paths.embedding, numThreads: 2 },
      clustering: { numClusters: this.numClusters, threshold: 0.85 },
      minDurationOn: 0.25,
      minDurationOff: 0.5,
    });
    if (diarizer.sampleRate !== wave.sampleRate) {
      throw new Error(`采样率不匹配: diarizer ${diarizer.sampleRate}, wav ${wave.sampleRate}`);
    }
    const rawSegments = diarizer.process(samples);
    timings.diarization = (performance.now() - t0) / 1000;

    const utterances = buildUtterances(rawSegments);
    const speakers = [...new Set(utterances.map((u) => u.speaker))].sort((a, b) => a - b);
    const speakerName = new Map(speakers.map((s, i) => [s, `S${i + 1}`]));

    const modelConfig = this.mode === "zipformer"
      ? {
          transducer: {
            encoder: this.paths.zipformerEncoder,
            decoder: this.paths.zipformerDecoder,
            joiner: this.paths.zipformerJoiner,
          },
          tokens: this.paths.zipformerTokens,
          modelingUnit: "bpe",
          bpeVocab: this.paths.zipformerBpe,
          numThreads: 4,
          provider: "cpu",
          debug: 0,
        }
      : {
          paraformer: { model: this.paths.paraformer },
          tokens: this.paths.paraformerTokens,
          numThreads: 4,
          provider: "cpu",
          debug: 0,
        };
    const recognizer = new api.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig,
      decodingMethod: this.mode === "zipformer" ? "modified_beam_search" : "greedy_search",
      hotwordsScore: 2.0,
    });

    const glossary = options.glossary;
    let hotwords: string | undefined;
    if (options.hotwords && this.mode === "zipformer" && glossary) {
      hotwords = process.env.SHERPA_HOTWORDS ?? [...new Set(Object.values(glossary.replace))]
        .filter(Boolean)
        .map((t) => t)
        .join(" / ");
    }

    let punct: { addPunct(text: string): string } | null = null;
    t0 = performance.now();
    try {
      punct = new api.OfflinePunctuation({ model: { ctTransformer: this.paths.punctuation, numThreads: 1, provider: "cpu" } });
    } catch (err) {
      notes.push(`标点模型不可用: ${err instanceof Error ? err.message : String(err)}`);
    }
    timings.punctuationModel = (performance.now() - t0) / 1000;

    let glossaryMode: AsrRun["glossaryMode"] = "none";
    if (options.hotwords && glossary) {
      const hasReplace = Object.keys(glossary.replace).length > 0;
      if (this.mode === "zipformer") {
        glossaryMode = hotwords ? "hotwords" : "none";
        notes.push(`热词上下文已启用: ${hotwords || "(无术语)"}`);
      } else {
        notes.push("paraformer 不支持热词（sherpa-onnx 仅 transducer 支持 contextual biasing），术语表只做字面替换");
        glossaryMode = hasReplace ? "replace" : "none";
      }
    }

    t0 = performance.now();
    const results: AsrUtterance[] = [];
    const pad = 0.2;
    for (let i = 0; i < utterances.length; i++) {
      const u = utterances[i]!;
      const startSample = Math.max(0, Math.floor((u.start - pad) * wave.sampleRate));
      const endSample = Math.min(samples.length, Math.ceil((u.end + pad) * wave.sampleRate));
      const stream = recognizer.createStream(hotwords);
      stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: samples.subarray(startSample, endSample) });
      recognizer.decode(stream);
      const raw = (recognizer.getResult(stream).text ?? "").trim();
      if (raw) {
        const text = applyGlossary(punct ? punct.addPunct(raw) : raw, glossary?.replace ?? {});
        results.push({
          start: u.start,
          end: u.end,
          speaker: speakerName.get(u.speaker) ?? `S${u.speaker + 1}`,
          text,
        });
      }
      options.onProgress?.({ stage: "asr", done: i + 1, total: utterances.length, detail: `spk=${u.speaker}` });
    }
    timings.asr = (performance.now() - t0) / 1000;

    const cleaned = cleanupSpeakers(results, 3);
    notes.push(`${rawSegments.length} 个原始分段 → ${utterances.length} 个识别分段，${speakers.length} 个聚类 → ${cleaned.length} 个有效说话人`);
    return {
      provider: "sherpa",
      model: this.model,
      utterances: cleaned.utterances,
      capabilities: this.capabilities,
      glossaryMode,
      notes,
      timings,
    };
  }
}
