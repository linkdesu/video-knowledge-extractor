/**
 * 区间重跑时的**声纹映射**接线（#145 r91j）：
 * 把「同时间 + 同文本」立不了身份的局部簇，用同一份 CAM++ 嵌入对既有说话人质心做归属，
 * 从而不再按时间重叠/局部排名铸假新人（真机：7→8、3→5 里新增的编号经复算都是既有说话人
 * 或相邻两行拼接碎片）。
 *
 * 既有说话人的参考音频**不落任何持久化结构**：从来源媒体音频 + 已有字幕的时间范围即时推导，
 * 中间产物只写缓存目录（`voiceprint-ref.wav` 与质心 JSON），`video.json` 的 schema 不变。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readWav, resolveModelPaths } from "../asr/sherpa";
import { extractAudio } from "../core/audio";
import { cacheKey, readCache, writeCache } from "../core/cache";
import { logger } from "../core/logger";
import type { Utterance } from "../core/types";
import { extractSegmentEmbeddings, SPEAKER_EMBED_MIN_SECONDS } from "../asr/embeddings";
import type { EmbeddingRow } from "../asr/refine";
import type { SpeakerAlignment } from "../asr/overlap-dedup";
import {
  mapClustersByVoiceprint,
  speakerCentroids,
  VOICEPRINT_ACCEPT,
  VOICEPRINT_MIN_SEED_SECONDS,
  type ClusterDecision,
} from "../asr/voiceprint";

/** 测试注入：段级嵌入（不加载 CAM++ 也能验接线）。 */
export type RangeVoiceprintDeps = {
  embedSpans?: (input: { samples: Float32Array; sampleRate: number; spans: ReadonlyArray<{ start: number; end: number }> }) => EmbeddingRow[];
};

export type RangeVoiceprintResult = {
  alignment: SpeakerAlignment;
  decisions: ClusterDecision[];
  references: number;
  localClusters: number;
  /** 本次是否真的算了嵌入（没有待映射簇时为 false）。 */
  computed: boolean;
};

/** 来源媒体整段 wav 的缓存路径：只写视频缓存目录，不进 video.json。 */
function referenceWavPath(cacheDir: string): string {
  return join(cacheDir, "voiceprint-ref.wav");
}

async function ensureReferenceAudio(mediaPath: string, cacheDir: string): Promise<string> {
  const wavPath = referenceWavPath(cacheDir);
  if (existsSync(wavPath)) return wavPath;
  await extractAudio(mediaPath, wavPath);
  logger().info("asr", "声纹参考音频已生成", { mediaPath, wavPath });
  return wavPath;
}

export async function alignRangeByVoiceprint(input: {
  existing: readonly Utterance[];
  incoming: readonly Utterance[];
  alignment: SpeakerAlignment;
  mediaPath: string;
  rangeWavPath: string;
  rangeStart: number;
  cacheDir: string;
  modelDir: string;
  deps?: RangeVoiceprintDeps;
  /** 测试注入：直接给整段参考音频（跳过 ffmpeg 解码与 wav 缓存）。 */
  referenceAudio?: { samples: Float32Array; sampleRate: number };
}): Promise<RangeVoiceprintResult> {
  const pending = [...new Set(input.incoming.map((row) => row.speakerId))].filter((id) => !input.alignment.has(id));
  if (pending.length === 0) {
    return { alignment: input.alignment, decisions: [], references: 0, localClusters: 0, computed: false };
  }
  const embed =
    input.deps?.embedSpans ??
    (({ samples, sampleRate, spans }: { samples: Float32Array; sampleRate: number; spans: ReadonlyArray<{ start: number; end: number }> }) =>
      extractSegmentEmbeddings({
        samples,
        sampleRate,
        segments: spans,
        modelPath: resolveModelPaths(input.modelDir).embedding,
      }));

  // 参考：来源媒体整段音频 + 已有字幕的时间范围（即时推导，不持久化说话人嵌入）
  const referenceAudio = input.referenceAudio ?? readWav(await ensureReferenceAudio(input.mediaPath, input.cacheDir));
  const referenceRows = input.existing.filter((row) => row.end - row.start >= SPEAKER_EMBED_MIN_SECONDS);
  const referenceKey = cacheKey("transcribe", {
    kind: "voiceprint-references",
    audio: `${referenceAudio.samples.length}@${referenceAudio.sampleRate}`,
    rows: referenceRows.map((row) => `${row.speakerId}:${row.start.toFixed(1)}-${row.end.toFixed(1)}`).join(","),
  });
  let referenceEmbeddings = readCache<EmbeddingRow[]>(input.cacheDir, referenceKey);
  if (referenceEmbeddings === undefined) {
    referenceEmbeddings = embed({
      samples: referenceAudio.samples,
      sampleRate: referenceAudio.sampleRate,
      spans: referenceRows.map((row) => ({ start: row.start, end: row.end })),
    });
    writeCache(input.cacheDir, referenceKey, referenceEmbeddings);
  }
  const references = speakerCentroids(
    referenceEmbeddings.map((embedding, index) => ({ ...embedding, speakerId: referenceRows[index]?.speakerId })),
  );

  // 区间：用区间 wav（时间相对区间起点）+ 本次局部簇
  const rangeAudio = readWav(input.rangeWavPath);
  const pendingRows = input.incoming.filter((row) => row.speakerId !== undefined && pending.includes(row.speakerId));
  const rangeEmbeddings = embed({
    samples: rangeAudio.samples,
    sampleRate: rangeAudio.sampleRate,
    spans: pendingRows.map((row) => ({ start: row.start - input.rangeStart, end: row.end - input.rangeStart })),
  });
  const localRows = rangeEmbeddings.map((embedding, index) => ({
    ...embedding,
    speakerId: pendingRows[index]?.speakerId,
  }));
  const decisions = [...mapClustersByVoiceprint(localRows, references, {
    accept: VOICEPRINT_ACCEPT,
    minSeedSeconds: VOICEPRINT_MIN_SEED_SECONDS,
  }).values()];

  const merged = new Map(input.alignment);
  for (const decision of decisions) {
    if (decision.speakerId !== undefined) merged.set(decision.local, decision.speakerId);
  }
  return { alignment: merged, decisions, references: references.size, localClusters: decisions.length, computed: true };
}

/** 供证据/日志用的紧凑表：局部编号、余弦、种子秒数、决策。 */
export function voiceprintTable(decisions: readonly ClusterDecision[]): Array<[string, number, number, number, string]> {
  return decisions.map((decision) => [
    decision.local,
    decision.cosine,
    decision.secondCosine,
    decision.seedSeconds,
    decision.reason,
  ]);
}
