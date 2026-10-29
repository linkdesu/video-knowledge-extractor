import { describe, expect, test } from "bun:test";
import { bicBestK, refineSegments } from "./refine";
import type { EmbeddingRow } from "./refine";

/** 生成 dim 维、以 base 为主方向的单位向量 + 轻微噪声。 */
function vector(dim: number, base: number, noise: number, seedIndex: number): number[] {
  const out = new Array<number>(dim).fill(0);
  out[base % dim] = 1;
  for (let i = 0; i < dim; i += 1) {
    out[i] = (out[i] ?? 0) + Math.sin(seedIndex * 31 + i * 17) * noise;
  }
  return out;
}

function cluster(base: number, count: number, dim = 8, noise = 0.05): number[][] {
  return Array.from({ length: count }, (_, i) => vector(dim, base, noise, base * 100 + i));
}

function rows(vectors: number[][], seconds = 2): { segments: { start: number; end: number; speaker: number }[]; embeddings: EmbeddingRow[] } {
  return {
    segments: vectors.map((_, i) => ({ start: i * (seconds + 1), end: i * (seconds + 1) + seconds, speaker: 0 })),
    embeddings: vectors.map((v, i) => ({ start: i * (seconds + 1), end: i * (seconds + 1) + seconds, v })),
  };
}

describe("二次聚类 refine", () => {
  test("三个分离良好的簇 → silhouette 选出 3", () => {
    const all = [...cluster(0, 12), ...cluster(3, 12), ...cluster(6, 12)];
    const input = rows(all);
    const result = refineSegments(input.segments, input.embeddings);
    expect(result.picked).toBe("sil");
    expect(result.k).toBe(3);
    expect(new Set(result.labels).size).toBe(3);
  });

  test("单人音频被 BIC 守卫判成一个簇", () => {
    const single = cluster(2, 30, 8, 0.002);
    const input = rows(single);
    const result = refineSegments(input.segments, input.embeddings);
    expect(result.picked).toBe("bic1");
    expect(result.k).toBe(1);
    expect(result.bicK).toBe(1);
  });

  test("种子不足 8 时退回固定切点", () => {
    const all = [...cluster(0, 3), ...cluster(5, 3)];
    const input = rows(all);
    const result = refineSegments(input.segments, input.embeddings);
    expect(result.picked).toBe("fallback");
    expect(result.seeds).toBe(6);
  });

  test("种子少于 2 时沿用 sherpa 标签", () => {
    const segments = [
      { start: 0, end: 0.4, speaker: 4 },
      { start: 1, end: 1.3, speaker: 9 },
    ];
    const embeddings: EmbeddingRow[] = segments.map((s) => ({ start: s.start, end: s.end, v: null }));
    const result = refineSegments(segments, embeddings);
    expect(result.picked).toBe("sherpa");
    expect(result.labels).toEqual([4, 9]);
  });

  test("短段：前后种子同簇则沿用", () => {
    const dim = 8;
    const segs: { start: number; end: number; speaker: number }[] = [];
    const embeds: EmbeddingRow[] = [];
    const push = (start: number, end: number, v: number[] | null, speaker: number) => {
      segs.push({ start, end, speaker });
      embeds.push({ start, end, v });
    };
    // a 簇两个长段，中间夹一个短段（前后种子都是 a）
    push(0, 2, vector(dim, 0, 0.02, 1), 0);
    push(2.1, 2.5, [0, 0, 0, 0, 0.2, 0.1, 0, 0], 0);
    push(2.6, 4.6, vector(dim, 0, 0.02, 2), 1);
    push(5.2, 7.2, vector(dim, 0, 0.02, 3), 2);
    push(7.8, 9.8, vector(dim, 0, 0.02, 4), 3);
    // b 簇四个长段，中间夹一个短段（前后种子都是 b）
    push(10.4, 12.4, vector(dim, 4, 0.02, 5), 4);
    push(12.5, 12.9, [0, 0, 0, 0, 0.2, 0.1, 0, 0], 5);
    push(13, 15, vector(dim, 4, 0.02, 6), 6);
    push(15.6, 17.6, vector(dim, 4, 0.02, 7), 7);
    push(18.2, 20.2, vector(dim, 4, 0.02, 8), 8);
    const result = refineSegments(segs, embeds);
    expect(result.k).toBe(2);
    expect(result.labels[1]).toBe(result.labels[0] as number);
    expect(result.labels[6]).toBe(result.labels[5] as number);
    expect(result.labels[0]).not.toBe(result.labels[5] as number);
  });

  test("BIC 在单簇上选 1", () => {
    const single = cluster(1, 24, 8, 0.002).map((v) => Float64Array.from(v));
    expect(bicBestK(single).k).toBe(1);
  });
});
