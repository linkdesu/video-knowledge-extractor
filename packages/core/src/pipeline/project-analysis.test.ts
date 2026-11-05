import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AsrEngine } from "../asr/engine";
import type { LlmClient, LlmEndpoint } from "../core/steps";
import type { SpeakerId, VideoId } from "../core/types";
import { loadVideoData } from "../core/video-data";
import { makeTmpDir } from "../testing/temp-dirs";
import { analyzeVideoRange } from "./project-analysis";

const endpoint: LlmEndpoint = { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "test-model" };

function makeMp4(path: string, seconds: number): void {
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=red:s=128x80:d=${seconds}`,
      "-f",
      "lavfi",
      "-i",
      `sine=d=${seconds}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      path,
    ],
    { stdio: "pipe" },
  );
}

/** 假 ASR：每次调用的时间戳都从 0 开始（相对区间），由管线负责加区间起点。 */
function fakeEngine(calls: { wavPath: string }[]): AsrEngine {
  return {
    id: "local",
    modelId: "fake-asr",
    run: async (input) => {
      calls.push({ wavPath: input.wavPath });
      return {
        transcript: {
          speakers: [{ id: "s1" as SpeakerId, name: "说话人 1", color: "#888888" }],
          utterances: [
            { start: 0.2, end: 0.6, speakerId: "s1" as SpeakerId, text: "第一句" },
            { start: 0.8, end: 1.2, speakerId: "s1" as SpeakerId, text: "第二句" },
          ],
        },
        chunks: [{ index: 1, start: 0, end: 2 }],
        timings: {},
        cacheHits: [],
        engine: "local",
        modelId: "fake-asr",
      };
    },
  };
}

function fakeClient(): LlmClient {
  return {
    model: endpoint.model,
    chat: async (_messages, opts) => {
      if (!opts?.json) throw new Error("需要 json");
      const system = _messages[0]?.content ?? "";
      if (system.includes("主题")) {
        return JSON.stringify({ topics: [{ title: "区间主题", summary: "摘要", segments: [{ start: 0, end: 1 }] }] });
      }
      return JSON.stringify({ rows: [] });
    },
  };
}

describe("analyzeVideoRange：一个文件一个区间，按块增量", () => {
  test("首个区间：注册视频、转写偏移到区间起点、主题以 proposed 落盘", async () => {
    const root = makeTmpDir("project-analysis-");
    const notesRoot = join(root, "notes");
    const cacheRoot = join(root, "cache");
    const source = join(root, "src.mp4");
    makeMp4(source, 4);
    const calls: { wavPath: string }[] = [];

    const first = await analyzeVideoRange({
      videoPath: source,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 2,
      endpoint,
      client: fakeClient(),
      asrEngine: fakeEngine(calls),
    });

    expect(first.topics.map((t) => t.title)).toEqual(["区间主题"]);
    expect(first.topics[0]?.lineIds).toHaveLength(2);
    const data = loadVideoData(first.outputDir, { id: first.videoId as VideoId, title: "" });
    expect(data.transcript.utterances.map((u) => [u.start, u.text])).toEqual([
      [0.2, "第一句"],
      [0.8, "第二句"],
    ]);
    expect(data.topics.map((t) => t.status)).toEqual(["proposed"]);
    expect(data.chunks).toEqual([{ index: 1, start: 0, end: 2 }]);
    expect(calls).toHaveLength(1);
  });

  test("第二个区间：字幕按区间起点偏移，只追加、不重写已完成区间", async () => {
    const root = makeTmpDir("project-analysis-");
    const notesRoot = join(root, "notes");
    const cacheRoot = join(root, "cache");
    const source = join(root, "src.mp4");
    makeMp4(source, 4);
    const calls: { wavPath: string }[] = [];

    const first = await analyzeVideoRange({
      videoPath: source,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 2,
      endpoint,
      client: fakeClient(),
      asrEngine: fakeEngine(calls),
    });
    const second = await analyzeVideoRange({
      videoPath: source,
      outputDir: first.outputDir,
      notesRoot,
      cacheRoot,
      startSeconds: 2,
      endSeconds: 4,
      endpoint,
      client: fakeClient(),
      asrEngine: fakeEngine(calls),
    });

    expect(second.videoId).toBe(first.videoId);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.wavPath).not.toBe(calls[0]?.wavPath);
    const data = loadVideoData(second.outputDir, { id: second.videoId as VideoId, title: "" });
    expect(data.transcript.utterances.map((u) => [Math.round(u.start * 10) / 10, u.text])).toEqual([
      [0.2, "第一句"],
      [0.8, "第二句"],
      [2.2, "第一句"],
      [2.8, "第二句"],
    ]);
    expect(data.chunks.map((c) => [c.start, c.end])).toEqual([
      [0, 2],
      [2, 4],
    ]);
    expect(data.topics).toHaveLength(2);
    expect(new Set(data.topics.map((t) => t.id)).size).toBe(2);
    expect(second.topics[0]?.id).not.toBe(first.topics[0]?.id);
    // 原始字幕文本不改写（纠错只在展示层应用）
    expect(readFileSync(join(second.outputDir, "video.json"), "utf8")).toContain("第一句");
  });
});
