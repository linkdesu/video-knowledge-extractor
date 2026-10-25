/**
 * 本地 ASR 引擎：现有 sherpa 实现整体搬入（ADR-0015 §5），行为、缓存键、进度、
 * timings 与原 `transcribeVideo` 一字不改，只多返回 `engine`/`modelId`。
 */
import { assignSpeakers, buildSpans, splitSpan } from "./utterances";
import { ASR_PADDING_SECONDS, DIARIZATION_TUNING, createTranscriber, readWav, resolveModelPaths } from "./sherpa";
import type { DiarizationSegment, Transcriber } from "./sherpa";
import { detectSilences, planChunks } from "../core/audio";
import { cacheKey, hashJson, readCache, sha256, writeCache } from "../core/cache";
import { ASR_MAX_UTTERANCE_SECONDS, ASR_MODEL_ID, DIARIZATION_MODEL_ID, PUNCTUATION_MODEL_ID } from "../core/config";
import { logger } from "../core/logger";
import type { Utterance } from "../core/types";
import type { AsrInput, AsrRun } from "./engine";

export type LocalEngine = {
  id: "local";
  modelId: string;
  run(input: AsrInput): Promise<AsrRun>;
};

export function createLocalEngine({ modelDir }: { modelDir: string }): LocalEngine {
  return {
    id: "local",
    modelId: ASR_MODEL_ID,
    run: async (input) => {
      const timings: Record<string, number> = {};
      const cacheHits: string[] = [];
      const t = (ms: number) => Math.round(ms / 10) / 100;

      const t0 = performance.now();
      const { samples, sampleRate } = readWav(input.wavPath);
      timings.readWave = t(performance.now() - t0);
      if (sampleRate !== 16000) throw new Error(`wav 采样率必须是 16000，实际 ${sampleRate}（${input.wavPath}）`);
      const duration = samples.length / sampleRate;
      logger().info("asr", "wav 读取完成", {
        samples: samples.length,
        sampleRate,
        durationSeconds: Math.round(duration * 100) / 100,
      });

      const s0 = performance.now();
      const silences = await detectSilences(input.wavPath);
      timings.silence = t(performance.now() - s0);
      const chunks = planChunks(duration, silences);
      logger().info("asr", "静音分块计划", { silenceCount: silences.length, chunkCount: chunks.length });

      let transcriber: Transcriber | undefined;
      const getTranscriber = async (): Promise<Transcriber> => {
        if (transcriber === undefined) {
          try {
            // 加载失败由 step 先记录完整 error 与 stack，随后按原包装消息抛出
            transcriber = await logger().step("asr", "ASR 模型加载", () => createTranscriber(resolveModelPaths(modelDir)));
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
      const cachedSegments = readCache<DiarizationSegment[]>(input.cacheDir, diarKey);
      const cacheHit = cachedSegments !== undefined;
      if (cacheHit) {
        cacheHits.push("diarization");
        logger().info("asr", "转写缓存命中", { kind: "diarization" });
      }
      let segments: DiarizationSegment[];
      if (cachedSegments === undefined) {
        try {
          segments = await logger().step("diarization", "说话人分离", async () => (await getTranscriber()).diarize(samples));
          writeCache(input.cacheDir, diarKey, segments);
        } catch (err) {
          // step 已记录 error/stack，包装消息保持不变
          throw new Error(`说话人分离失败（整条 wav 0–${duration.toFixed(1)}s）：${(err as Error).message}`);
        }
      } else {
        segments = cachedSegments;
      }
      logger().info("diarization", "说话人分离完成", {
        segments: segments.length,
        durationMs: t(performance.now() - d0),
        cacheHit,
      });

      const spans = buildSpans(segments).flatMap((span) => splitSpan(span, silences, ASR_MAX_UTTERANCE_SECONDS));
      const { speakers, utterances } = assignSpeakers(spans);
      timings.diarization = t(performance.now() - d0);

      let done = 0;
      const reportProgress = () => {
        done += 1;
        input.onProgress?.({ step: "transcribe", done, total: utterances.length });
      };

      const decodeOne = async (u: Utterance, chunkIndex: number): Promise<string> => {
        const from = Math.max(0, Math.round((u.start - ASR_PADDING_SECONDS) * sampleRate));
        const to = Math.min(samples.length, Math.round((u.end + ASR_PADDING_SECONDS) * sampleRate));
        try {
          return (await getTranscriber()).decode(samples.subarray(from, to));
        } catch (err) {
          // 原有包装错误前先落完整 error 与 stack
          logger().error("asr", "字幕行解码失败", { error: (err as Error).message, stack: (err as Error).stack });
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

      const a0 = performance.now();
      for (const chunk of chunks) {
        const us = byChunk.get(chunk.index);
        if (us === undefined) continue;
        const chunkStart = performance.now();
        let chunkCacheHit = false;
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
        logger().info("asr", `分块 ASR 开始 (${chunk.index + 1}/${chunks.length})`, { chunkIndex: chunk.index + 1, chunkCount: chunks.length });
        const cached = readCache<{ texts: string[] }>(input.cacheDir, key);
        if (cached !== undefined) {
          chunkCacheHit = true;
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
            u.text = await decodeOne(u, chunk.index);
            texts.push(u.text);
            reportProgress();
          }
          writeCache(input.cacheDir, key, { texts });
        }
        logger().info("asr", "分块 ASR 完成", {
          chunkIndex: chunk.index,
          chunkCount: chunks.length,
          utterances: us.length,
          durationMs: Math.round(performance.now() - chunkStart),
          cacheHit: chunkCacheHit,
        });
      }
      timings.asr = t(performance.now() - a0);

      const transcript = {
        speakers,
        utterances: utterances.filter((u) => u.text !== ""),
      };
      timings.total = t(performance.now() - t0);
      logger().info("asr", "本地 ASR 完成", {
        utterances: transcript.utterances.length,
        speakers: speakers.length,
        cacheHit: cacheHits.length > 0,
        timings,
      });
      return { transcript, chunks, timings, cacheHits, engine: "local", modelId: ASR_MODEL_ID };
    },
  };
}
