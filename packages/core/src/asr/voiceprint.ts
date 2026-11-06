/**
 * 区间局部聚类 → 既有说话人的**声纹映射**（#145 r91j）。
 *
 * 区间重跑会重新做分离与二次聚类，局部编号只是「本次音频内的时长排名」，不是身份；
 * 只靠「同时间 + 同文本」立证据时，ASR 把相邻两行拼成一条、或重跑的端点漂移，就会
 * 证不出来 → 按 ADR-0052 铸新号 → 用户看到 7 个人变 8 个、3 个人变 5 个，其中
 * 新人经 CAM++ 复算其实是既有说话人（真机：直播新编号对既有 speaker-2 余弦 0.864；
 * 6 分钟片段的新编号是相邻两行拼接碎片，对既有人 0.74–0.80）。
 *
 * 这里用**同一份 CAM++ 嵌入**把局部簇质心与既有说话人质心做余弦比对：
 * - 达到阈值（默认 0.65）→ 归回原编号；
 * - 低于阈值但该簇有足够可信的种子时长（默认 3 秒，与 `assignSpeakers` 的保留闸同口径）
 *   → 允许建新号（真实新人）；
 * - 低于阈值且种子不足（短片段、拼接碎片）→ 跟随最近质心，不单独建人。
 *
 * 阈值依据（QA r91i 实测，同一素材同一模型）：不同人的跨编号质心相似度 ≤ 0.489，
 * 同一人的新编号对既有编号 0.74–0.86。0.65 落在两团之间的空档里；调参要重跑真机，不凭直觉。
 *
 * 纯函数：嵌入由调用方给（正式管线来自 `extractSegmentEmbeddings`），方便在没有模型时测边界。
 */
import type { EmbeddingRow } from "./refine";

/** 同一人的余弦下限。QA 实测同人 0.74–0.86、不同人 ≤0.49。 */
export const VOICEPRINT_ACCEPT = 0.65;
/** 允许建新号的最小「可信种子时长」：与 `assignSpeakers` 的 minSeconds 同口径。 */
export const VOICEPRINT_MIN_SEED_SECONDS = 3;

export type VoiceRow = { start: number; end: number; speakerId?: string; v: number[] | null };

export type SpeakerCentroid = { speakerId: string; centroid: Float64Array; seconds: number; samples: number };

export type ClusterDecision = {
  local: string;
  /** 映射到的既有说话人；`undefined` 表示允许铸新号（真实新人或没有任何参考）。 */
  speakerId?: string;
  cosine: number;
  secondCosine: number;
  /** 参与质心的行时长合计（秒）。 */
  seedSeconds: number;
  reason: "voiceprint" | "nearest" | "new" | "no-reference";
};

function normalized(vector: readonly number[]): Float64Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  const scale = 1 / (Math.sqrt(norm) + 1e-12);
  const out = new Float64Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = (vector[i] ?? 0) * scale;
  return out;
}

function cosine(a: Float64Array, b: Float64Array): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

/** 把若干行（每行带一个嵌入）按说话人聚成质心；没有嵌入的行忽略。 */
export function speakerCentroids(rows: readonly VoiceRow[]): Map<string, SpeakerCentroid> {
  const groups = new Map<string, { sum: Float64Array; seconds: number; samples: number }>();
  for (const row of rows) {
    const id = row.speakerId;
    const vector = row.v;
    if (id === undefined || vector === null || vector.length === 0) continue;
    const unit = normalized(vector);
    const group = groups.get(id) ?? { sum: new Float64Array(unit.length), seconds: 0, samples: 0 };
    if (group.sum.length !== unit.length) continue;
    for (let i = 0; i < unit.length; i += 1) group.sum[i] = (group.sum[i] ?? 0) + (unit[i] ?? 0);
    group.seconds += Math.max(0, row.end - row.start);
    group.samples += 1;
    groups.set(id, group);
  }
  const out = new Map<string, SpeakerCentroid>();
  for (const [speakerId, group] of groups) {
    out.set(speakerId, { speakerId, centroid: normalized(Array.from(group.sum)), seconds: group.seconds, samples: group.samples });
  }
  return out;
}

/**
 * 每个局部簇的映射决策。`references` 是既有说话人质心（空表示整段还没有人）。
 * 决策顺序：声纹命中 → 种子够则允许新人 → 否则跟随最近质心。
 */
export function mapClustersByVoiceprint(
  localRows: readonly VoiceRow[],
  references: ReadonlyMap<string, SpeakerCentroid>,
  opts: { accept?: number; minSeedSeconds?: number } = {},
): Map<string, ClusterDecision> {
  const accept = opts.accept ?? VOICEPRINT_ACCEPT;
  const minSeedSeconds = opts.minSeedSeconds ?? VOICEPRINT_MIN_SEED_SECONDS;
  const clusters = speakerCentroids(localRows);
  const decisions = new Map<string, ClusterDecision>();
  for (const [local, cluster] of clusters) {
    let best: SpeakerCentroid | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    let secondScore = Number.NEGATIVE_INFINITY;
    for (const reference of references.values()) {
      const score = cosine(cluster.centroid, reference.centroid);
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        best = reference;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
    const cosineValue = best === undefined ? 0 : Math.round(bestScore * 1000) / 1000;
    const secondValue = secondScore === Number.NEGATIVE_INFINITY ? 0 : Math.round(secondScore * 1000) / 1000;
    const base = { local, cosine: cosineValue, secondCosine: secondValue, seedSeconds: Math.round(cluster.seconds * 10) / 10 };
    if (best === undefined) {
      decisions.set(local, { ...base, reason: "no-reference" });
      continue;
    }
    if (bestScore >= accept) {
      decisions.set(local, { ...base, speakerId: best.speakerId, reason: "voiceprint" });
      continue;
    }
    if (cluster.seconds >= minSeedSeconds) {
      decisions.set(local, { ...base, reason: "new" });
      continue;
    }
    // 短片段 / 拼接碎片：跟随最近质心，绝不单独建人
    decisions.set(local, { ...base, speakerId: best.speakerId, reason: "nearest" });
  }
  return decisions;
}

/** 把局部簇的嵌入行按时间戳对齐到一整段音频（区间 wav 是相对时间）。 */
export function shiftRows<T extends { start: number; end: number }>(rows: readonly T[], offset: number): T[] {
  return rows.map((row) => ({ ...row, start: row.start + offset, end: row.end + offset }));
}

export type { EmbeddingRow };
