import { describe, expect, test } from "bun:test";
import { mapClustersByVoiceprint, speakerCentroids } from "./voiceprint";

/** 与 main 方向一致的单位向量 + 轻微噪声。 */
function vector(base: number, noise = 0.03): number[] {
  const out = new Array<number>(8).fill(0);
  out[base] = 1;
  for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) + Math.sin(i * 5 + base) * noise;
  return out;
}

/** 让两个向量达到目标余弦：a 与 b 的夹角按需要调。 */
function pair(base: number, target: number): [number[], number[]] {
  const a = vector(base);
  const b = a.map((value, i) => (i === base ? target : Math.sqrt(Math.max(0, 1 - target * target)) * (i === (base + 1) % 8 ? 1 : 0) + value * 0));
  return [a, b];
}

const row = (start: number, end: number, speakerId: string, v: number[] | null) => ({ start, end, speakerId, v });

describe("speakerCentroids：按说话人聚质心", () => {
  test("同一说话人多行取平均方向；没有嵌入的行忽略", () => {
    const centroids = speakerCentroids([row(0, 2, "speaker-1", vector(0)), row(2, 4, "speaker-1", vector(0)), row(4, 6, "speaker-1", null)]);
    expect(centroids.size).toBe(1);
    const [centroid] = [...centroids.values()];
    expect(centroid?.samples).toBe(2);
    expect(centroid?.seconds).toBe(4);
    expect(Math.round((centroid?.centroid[0] ?? 0) * 100) / 100).toBe(1);
  });
});

describe("mapClustersByVoiceprint：声纹归属", () => {
  const references = speakerCentroids([row(0, 5, "speaker-2", vector(0))]);

  test("同人（余弦 0.86）→ 归回原编号，不建新人", () => {
    const [a, b] = pair(0, 0.86);
    const local = speakerCentroids([row(0, 5, "speaker-1", b)]);
    const decisions = mapClustersByVoiceprint([row(0, 5, "speaker-1", b)], references);
    expect(decisions.get("speaker-1")?.speakerId).toBe("speaker-2");
    expect(decisions.get("speaker-1")?.reason).toBe("voiceprint");
    expect(decisions.get("speaker-1")?.cosine).toBeGreaterThan(0.8);
    expect(local.size).toBe(1);
    expect(a[0]).toBe(1);
  });

  test("不同人（余弦 ≤0.49）且种子够 → 允许建新号", () => {
    const decisions = mapClustersByVoiceprint([row(0, 6, "speaker-1", vector(4))], references);
    expect(decisions.get("speaker-1")?.speakerId).toBeUndefined();
    expect(decisions.get("speaker-1")?.reason).toBe("new");
    expect(decisions.get("speaker-1")?.cosine).toBeLessThan(0.65);
  });

  test("不同人但种子不足（短片段/拼接碎片）→ 跟随最近质心，不单独建人", () => {
    const decisions = mapClustersByVoiceprint([row(0, 1.2, "speaker-1", vector(4))], references);
    expect(decisions.get("speaker-1")?.speakerId).toBe("speaker-2");
    expect(decisions.get("speaker-1")?.reason).toBe("nearest");
  });

  test("整段还没有任何参考 → 不硬塞编号（交给铸号）", () => {
    const decisions = mapClustersByVoiceprint([row(0, 5, "speaker-1", vector(1))], new Map());
    expect(decisions.get("speaker-1")?.reason).toBe("no-reference");
    expect(decisions.get("speaker-1")?.speakerId).toBeUndefined();
  });

  test("没有嵌入的簇不参与决策（不因缺证据被冒认或误判）", () => {
    const decisions = mapClustersByVoiceprint([row(0, 5, "speaker-1", null)], references);
    expect(decisions.size).toBe(0);
  });

  test("三位参考里选最像的那位，并给出第二名的余弦", () => {
    const many = speakerCentroids([
      row(0, 5, "speaker-1", vector(0)),
      row(5, 9, "speaker-2", vector(3)),
      row(9, 13, "speaker-3", vector(6)),
    ]);
    const [, target] = pair(3, 0.8);
    const decisions = mapClustersByVoiceprint([row(0, 5, "speaker-9", target)], many);
    expect(decisions.get("speaker-9")?.speakerId).toBe("speaker-2");
    expect(decisions.get("speaker-9")?.secondCosine).toBeLessThan(0.65);
  });
});
