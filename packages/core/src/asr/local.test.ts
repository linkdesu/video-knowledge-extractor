import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { EmbeddingRow } from "./refine";
import { createLocalEngine } from "./local";
import type { Transcriber } from "./sherpa";
import { makeTmpDir } from "../testing/temp-dirs";

/** 16 kHz 单声道 wav：只有静音，转写与嵌入全部由注入的假实现提供。 */
function makeWav(path: string, seconds: number): void {
  execFileSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", `anullsrc=r=16000:cl=mono`, "-t", String(seconds), "-c:a", "pcm_s16le", path],
    { stdio: "pipe" },
  );
}

function vector(main: number, noise = 0.02): number[] {
  const out = new Array<number>(8).fill(0);
  out[main] = 1;
  for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) + Math.sin(i * 7 + main) * noise;
  return out;
}

describe("local 引擎：二次聚类接入正式管线（#145 r91h）", () => {
  test("sherpa 把两个人切成四个簇：按 refine 标签合并成两个人", async () => {
    const dir = makeTmpDir("local-refine-");
    const wavPath = join(dir, "audio.wav");
    makeWav(wavPath, 15);
    // sherpa 原始划分：0/1 是同一个人，2/3 是同一个人（真机里区间重跑常见）。
    // 每段 3.5 秒：`assignSpeakers` 的 3 秒闸门不会把簇丢掉，比较的只是簇数。
    const segments = [
      { start: 0, end: 3.5, speaker: 0 },
      { start: 3.5, end: 7, speaker: 1 },
      { start: 7, end: 10.5, speaker: 2 },
      { start: 10.5, end: 14, speaker: 3 },
    ];
    const transcriber: Transcriber = {
      sampleRate: 16000,
      diarize: () => segments.map((s) => ({ ...s })),
      decode: () => "一句话。",
    };
    const embeddings = (): EmbeddingRow[] =>
      segments.map((s, i) => ({ start: s.start, end: s.end, v: vector(i < 2 ? 0 : 4) }));

    const engine = createLocalEngine({ modelDir: join(dir, "no-models"), hooks: { transcriber, embeddings } });
    const run = await engine.run({ video: { id: "v1", path: wavPath, durationSeconds: 15 } as never, wavPath, cacheDir: join(dir, "cache") });

    // 二次聚类把 4 个 sherpa 簇并成 2 个人
    expect(run.transcript.speakers.map((s) => s.id as string)).toEqual(["speaker-1", "speaker-2"]);
    expect([...new Set(run.transcript.utterances.map((u) => u.speakerId as string))].sort()).toEqual(["speaker-1", "speaker-2"]);
  });

  test("拿不到段级嵌入时回落到 sherpa 原始簇（不静默改变划分）", async () => {
    const dir = makeTmpDir("local-refine-");
    const wavPath = join(dir, "audio.wav");
    makeWav(wavPath, 15);
    const segments = [
      { start: 0, end: 3.5, speaker: 0 },
      { start: 3.5, end: 7, speaker: 1 },
      { start: 7, end: 10.5, speaker: 2 },
      { start: 10.5, end: 14, speaker: 3 },
    ];
    const transcriber: Transcriber = {
      sampleRate: 16000,
      diarize: () => segments.map((s) => ({ ...s })),
      decode: () => "一句话。",
    };
    const engine = createLocalEngine({
      modelDir: join(dir, "no-models"),
      hooks: { transcriber, embeddings: () => segments.map((s) => ({ start: s.start, end: s.end, v: null })) },
    });
    const run = await engine.run({ video: { id: "v1", path: wavPath, durationSeconds: 15 } as never, wavPath, cacheDir: join(dir, "cache") });
    expect(run.transcript.speakers).toHaveLength(4);
  });
});
