import { assignSpeakers, buildSpans, splitSpan } from "../asr/utterances";
import { ASR_PADDING_SECONDS, DIARIZATION_TUNING, createTranscriber, readWav, resolveModelPaths } from "../asr/sherpa";
import type { DiarizationSegment, Transcriber } from "../asr/sherpa";
import { detectSilences, planChunks } from "../core/audio";
import { cacheKey, hashJson, readCache, sha256, writeCache } from "../core/cache";
import { ASR_MAX_UTTERANCE_SECONDS, ASR_MODEL_ID, DIARIZATION_MODEL_ID, PUNCTUATION_MODEL_ID } from "../core/config";
import type { Progress } from "../core/steps";
import type { Chunk, Transcript, Utterance, Video } from "../core/types";

export type TranscribeRun = {
  transcript: Transcript;
  chunks: Chunk[];
  timings: Record<string, number>;
  cacheHits: string[];
};

export async function transcribeVideo(input: {
  video: Video;
  wavPath: string;
  cacheDir: string;
  modelDir: string;
  onProgress?: (p: Progress) => void;
}): Promise<TranscribeRun> {
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
  const chunks = planChunks(duration, silences);

  let transcriber: Transcriber | undefined;
  const getTranscriber = (): Transcriber => {
    if (transcriber === undefined) {
      try {
        transcriber = createTranscriber(resolveModelPaths(input.modelDir));
      } catch (err) {
        throw new Error(`ASR 模型加载失败：${(err as Error).message}`);
      }
    }
    return transcriber;
  };

  const d0 = performance.now();
  const allBytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const diarKey = cacheKey("transcribe", {
    kind: "diarization",
    audio: sha256(allBytes),
    segmentation: DIARIZATION_MODEL_ID,
    embedding: "campplus-zh",
    windowShiftRatio: DIARIZATION_TUNING.windowShiftRatio,
    threshold: DIARIZATION_TUNING.threshold,
    minDurationOn: DIARIZATION_TUNING.minDurationOn,
    minDurationOff: DIARIZATION_TUNING.minDurationOff,
    tuning: JSON.stringify(DIARIZATION_TUNING),
  });
  let segments: DiarizationSegment[] | undefined = readCache(input.cacheDir, diarKey);
  if (segments === undefined) {
    try {
      segments = getTranscriber().diarize(samples);
    } catch (err) {
      throw new Error(`说话人分离失败（整条 wav 0–${duration.toFixed(1)}s）：${(err as Error).message}`);
    }
    writeCache(input.cacheDir, diarKey, segments);
  } else {
    cacheHits.push("diarization");
  }

  const spans = buildSpans(segments).flatMap((span) => splitSpan(span, silences, ASR_MAX_UTTERANCE_SECONDS));
  const { speakers, utterances } = assignSpeakers(spans);
  timings.diarization = t(performance.now() - d0);

  const a0 = performance.now();
  let done = 0;
  const reportProgress = () => {
    done += 1;
    input.onProgress?.({ step: "transcribe", done, total: utterances.length });
  };

  const decodeOne = (u: Utterance, chunkIndex: number): string => {
    const from = Math.max(0, Math.round((u.start - ASR_PADDING_SECONDS) * sampleRate));
    const to = Math.min(samples.length, Math.round((u.end + ASR_PADDING_SECONDS) * sampleRate));
    try {
      return getTranscriber().decode(samples.subarray(from, to));
    } catch (err) {
      throw new Error(`第 ${chunkIndex} 块字幕行 ${u.start.toFixed(1)}s–${u.end.toFixed(1)}s 解码失败：${(err as Error).message}`);
    }
  };

  const chunkIndexFor = (startSec: number): number => {
    if (chunks.length === 0) throw new Error("分块计划为空：音频时长或静音检测异常，无法把字幕行归入任何块");
    for (const c of chunks) if (startSec < c.end) return c.index;
    return chunks[chunks.length - 1]?.index ?? 0;
  };

  const byChunk = new Map<number, Utterance[]>();
  for (const u of utterances) {
    const ci = chunkIndexFor(u.start);
    const list = byChunk.get(ci);
    if (list !== undefined) list.push(u);
    else byChunk.set(ci, [u]);
  }

  for (const chunk of chunks) {
    const us = byChunk.get(chunk.index);
    if (us === undefined) continue;
    const from = Math.max(0, Math.round(chunk.start * sampleRate));
    const to = Math.min(samples.length, Math.round(chunk.end * sampleRate));
    const key = cacheKey("transcribe", {
      kind: "chunk",
      audio: sha256(new Uint8Array(samples.buffer, samples.byteOffset + from * 4, (to - from) * 4)),
      utterances: hashJson(us.map((u) => ({ start: u.start, end: u.end, speakerId: u.speakerId }))),
      asr: ASR_MODEL_ID,
      punctuation: PUNCTUATION_MODEL_ID,
      maxUtterance: ASR_MAX_UTTERANCE_SECONDS,
      padding: ASR_PADDING_SECONDS,
    });
    const cached = readCache<{ texts: string[] }>(input.cacheDir, key);
    if (cached !== undefined) {
      cacheHits.push(`chunk-${chunk.index}`);
      let i = 0;
      for (const u of us) {
        u.text = cached.texts[i] ?? "";
        i += 1;
        reportProgress();
      }
    } else {
      const texts: string[] = [];
      for (const u of us) {
        u.text = decodeOne(u, chunk.index);
        texts.push(u.text);
        reportProgress();
      }
      writeCache(input.cacheDir, key, { texts });
    }
  }
  timings.asr = t(performance.now() - a0);

  const transcript: Transcript = {
    speakers,
    utterances: utterances.filter((u) => u.text !== ""),
  };
  timings.total = t(performance.now() - t0);
  return { transcript, chunks, timings, cacheHits };
}
