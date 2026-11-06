/**
 * 本地 ASR 引擎：现有 sherpa 实现整体搬入（ADR-0015 §5），行为、缓存键、进度、
 * timings 与原 `transcribeVideo` 一字不改，只多返回 `engine`/`modelId`。
 */
import { assignSpeakers, buildSpans, splitCrosstalk, splitSpan } from "./utterances";
import { applyRefineLabels, REFINE_DEFAULTS, REFINE_VERSION, refineSegments, type EmbeddingRow, type RefineResult } from "./refine";
import { extractSegmentEmbeddings, SPEAKER_EMBED_MIN_SECONDS, type SpeakerEmbeddingInput } from "./embeddings";
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

/**
 * 测试注入点：转写器（分离 + 解码）与段级嵌入。正式调用方不传，一律走 sherpa/CAM++。
 * 二次聚类的接线因此可以在没有模型文件的机器上验到「按 refine 标签重排说话人」。
 */
export type LocalEngineHooks = {
  transcriber?: Transcriber;
  embeddings?: (input: Omit<SpeakerEmbeddingInput, "modelPath">) => EmbeddingRow[];
};

export function createLocalEngine({ modelDir, hooks }: { modelDir: string; hooks?: LocalEngineHooks }): LocalEngine {
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
        if (hooks?.transcriber !== undefined) return hooks.transcriber;
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

      /**
       * 二次聚类（r91h，ADR-0057）：sherpa 原始簇只按阈值切，短音频与区间重跑里同一个人
       * 常被切成两三个簇，跨次对齐因此证不出身份、字幕与说话人一起膨胀。Lab 的 refine
       * 方案一直是这个问题的正解，但过去只挂在验收台；这里把同一份 `refineSegments`
       * 接到正式管线，Lab 与正式转写的说话人划分从此同源。
       */
      const refined = await logger().step("diarization", "二次聚类", () =>
        refineSpeakerSegments(segments, {
          samples,
          sampleRate,
          resolveModelPath: () => resolveModelPaths(modelDir).embedding,
          extract: hooks?.embeddings,
          cacheDir: input.cacheDir,
          audioHash: sha256(allBytes),
          cacheHits,
          timings,
        }),
      );
      const labelled = refined.segments;
      logger().info("diarization", "二次聚类完成", {
        sherpaK: refined.sherpaK,
        refineK: refined.result.k,
        picked: refined.result.picked,
        silhouette: refined.result.silhouette,
        seeds: refined.result.seeds,
        cacheHit: refined.cacheHit,
      });

      const { spans, interjections } = splitCrosstalk(
        buildSpans(labelled).flatMap((span) => splitSpan(span, silences, ASR_MAX_UTTERANCE_SECONDS)),
      );
      // 插话（#114）单独成行但不参与说话人投票：有内容的靠 filterFillerUtterances 之前的解码留成一行，
      // 纯语气词的由同一条过滤隐藏。
      const { speakers, utterances } = assignSpeakers(spans, { interjections });
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
        // planChunks 的 index 已经是 1-based，日志与完成行、错误行共用同一序号
        logger().info("asr", `分块 ASR 开始 (${chunk.index}/${chunks.length})`, { chunkIndex: chunk.index, chunkCount: chunks.length });
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

      // 短回应/半截话（#98）与语义空洞短句（#109）的过滤集中在 pipeline 的 filterFillerUtterances：
      // 在落盘前统一跑一次，远程 ASR 与模型判定才都覆盖到，不再在这里先过滤一遍。
      const transcript = { speakers, utterances };
      timings.total = t(performance.now() - t0);
      logger().info("asr", "本地 ASR 完成", {
        utterances: transcript.utterances.length,
        speakers: speakers.length,
        interjections: interjections.length,
        cacheHit: cacheHits.length > 0,
        timings,
      });
      return { transcript, chunks, timings, cacheHits, engine: "local", modelId: ASR_MODEL_ID };
    },
  };
}

type RefineStageInput = {
  samples: Float32Array;
  sampleRate: number;
  /** 只在真的要走 CAM++ 时求值（测试注入嵌入时不解析模型路径）。 */
  resolveModelPath: () => string;
  /** 测试注入：替代 CAM++ 抽取。 */
  extract?: (input: Omit<SpeakerEmbeddingInput, "modelPath">) => EmbeddingRow[];
  cacheDir: string;
  audioHash: string;
  cacheHits: string[];
  timings: Record<string, number>;
};

/**
 * 二次聚类与它的两级缓存（ADR-0057）：
 * - 嵌入按「音频 + 嵌入模型 + 最短段时长」缓存，二次聚类按「音频 + 分离段 + 口径版本」缓存；
 * - 聚类参数（`REFINE_DEFAULTS`）与 `REFINE_VERSION` 都进键：改算法或参数即 miss，绝不静默沿用
 *   旧的说话人划分；
 * - 聚类缓存命中时不重算嵌入（嵌入只为聚类服务）。
 */
async function refineSpeakerSegments(
  segments: readonly DiarizationSegment[],
  input: RefineStageInput,
): Promise<{ segments: DiarizationSegment[]; result: RefineResult; sherpaK: number; cacheHit: boolean }> {
  const sherpaK = new Set(segments.map((segment) => segment.speaker)).size;
  const refineKey = cacheKey("transcribe", {
    kind: "refine",
    audio: input.audioHash,
    segments: hashJson(segments),
    version: REFINE_VERSION,
    defaults: JSON.stringify(REFINE_DEFAULTS),
    embedMinSeconds: SPEAKER_EMBED_MIN_SECONDS,
  });
  const cached = readCache<RefineResult>(input.cacheDir, refineKey);
  if (cached !== undefined) {
    input.cacheHits.push("refine");
    logger().info("asr", "转写缓存命中", { kind: "refine" });
    return { segments: applyRefineLabels(segments, cached.labels), result: cached, sherpaK, cacheHit: true };
  }

  const e0 = performance.now();
  const embedKey = cacheKey("transcribe", {
    kind: "embeddings",
    audio: input.audioHash,
    embedding: "campplus-zh",
    minSeconds: SPEAKER_EMBED_MIN_SECONDS,
  });
  let embeddings = readCache<EmbeddingRow[]>(input.cacheDir, embedKey);
  if (embeddings === undefined) {
    const request = { samples: input.samples, sampleRate: input.sampleRate, segments };
    embeddings =
      input.extract !== undefined
        ? input.extract(request)
        : extractSegmentEmbeddings({ ...request, modelPath: input.resolveModelPath() });
    writeCache(input.cacheDir, embedKey, embeddings);
  } else {
    input.cacheHits.push("embeddings");
    logger().info("asr", "转写缓存命中", { kind: "embeddings" });
  }
  input.timings.embed = Math.round((performance.now() - e0) / 10) / 100;

  const r0 = performance.now();
  const result = refineSegments([...segments], embeddings);
  writeCache(input.cacheDir, refineKey, result);
  input.timings.refine = Math.round((performance.now() - r0) / 10) / 100;
  return { segments: applyRefineLabels(segments, result.labels), result, sherpaK, cacheHit: false };
}
