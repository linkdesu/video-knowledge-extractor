import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AsrEngine } from "../asr/engine";
import { acquireVideoLock, isVideoLocked } from "../core/lock";
import type { LlmClient, LlmEndpoint } from "../core/steps";
import type { SpeakerId, VideoId } from "../core/types";
import { loadVideoData, writeVideoData } from "../core/video-data";
import { makeTmpDir } from "../testing/temp-dirs";
import { analyzeVideoRange, subtitleLinesFrom } from "./project-analysis";

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

function fakeClient(range: { start: number; end: number }): LlmClient {
  return {
    model: endpoint.model,
    chat: async (_messages, opts) => {
      if (!opts?.json) throw new Error("需要 json");
      const system = _messages[0]?.content ?? "";
      if (system.includes("主题")) {
        return JSON.stringify({ topics: [{ title: "区间主题", summary: "摘要", segments: [{ start: range.start, end: range.end }] }] });
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
      client: fakeClient({ start: 0, end: 2 }),
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
      client: fakeClient({ start: 0, end: 2 }),
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
      client: fakeClient({ start: 2, end: 4 }),
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

  test("区间落在已有转写里：只追加真正新增的字幕，不重复落盘、行 id 不变", async () => {
    const root = makeTmpDir("project-analysis-");
    const notesRoot = join(root, "notes");
    const cacheRoot = join(root, "cache");
    const source = join(root, "src.mp4");
    makeMp4(source, 4);

    // 视频库先整段转写过（复用视频库字幕，见 #121 规格 117），项目再分析其中的子区间
    const whole = await analyzeVideoRange({
      videoPath: source,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 4,
      endpoint,
      client: fakeClient({ start: 0, end: 4 }),
      asrEngine: fakeEngine([]),
    });
    const before = loadVideoData(whole.outputDir, { id: whole.videoId as VideoId, title: "" });
    expect(before.transcript.utterances).toHaveLength(2);

    const again = await analyzeVideoRange({
      videoPath: source,
      outputDir: whole.outputDir,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 2,
      endpoint,
      client: fakeClient({ start: 0, end: 2 }),
      asrEngine: fakeEngine([]),
    });

    const data = loadVideoData(again.outputDir, { id: again.videoId as VideoId, title: "" });
    expect(data.transcript.utterances.map((u) => [u.start, u.text])).toEqual([
      [0.2, "第一句"],
      [0.8, "第二句"],
    ]);
    expect(again.addedLines).toBe(0);
    // 已有行 id 不变：主题的 lineIds 仍指向同一批字幕
    expect(subtitleLinesFrom(data).filter((line) => again.topics[0]?.lineIds.includes(line.id)).map((line) => [line.start, line.text])).toEqual([
      [0.2, "第一句"],
      [0.8, "第二句"],
    ]);
  });

  test("后到的区间字幕排在前面时，已有行 id 仍指向同一行字幕", async () => {
    const root = makeTmpDir("project-analysis-");
    const notesRoot = join(root, "notes");
    const cacheRoot = join(root, "cache");
    const source = join(root, "src.mp4");
    makeMp4(source, 4);

    // 先分析后半段、再补前半段：合并后新行排到数组前面，下标型 id 会整体错位
    const tail = await analyzeVideoRange({
      videoPath: source,
      notesRoot,
      cacheRoot,
      startSeconds: 2,
      endSeconds: 4,
      endpoint,
      client: fakeClient({ start: 2, end: 4 }),
      asrEngine: fakeEngine([]),
    });
    const tailLines = subtitleLinesFrom(
      loadVideoData(tail.outputDir, { id: tail.videoId as VideoId, title: "" }),
    );
    expect(tailLines.map((line) => [line.start, line.text])).toEqual([
      [2.2, "第一句"],
      [2.8, "第二句"],
    ]);

    const head = await analyzeVideoRange({
      videoPath: source,
      outputDir: tail.outputDir,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 2,
      endpoint,
      client: fakeClient({ start: 0, end: 2 }),
      asrEngine: fakeEngine([]),
    });
    const headLines = subtitleLinesFrom(
      loadVideoData(head.outputDir, { id: head.videoId as VideoId, title: "" }),
    );
    expect(headLines.map((line) => [line.start, line.text])).toEqual([
      [0.2, "第一句"],
      [0.8, "第二句"],
      [2.2, "第一句"],
      [2.8, "第二句"],
    ]);

    // 弹窗打开期间字幕被插入时，已选 id 也必须解析回同一行（#129 提交精确性）
    const resolve = (ids: readonly string[]) =>
      headLines.filter((line) => ids.includes(line.id)).map((line) => [line.start, line.text]);
    expect(resolve(tailLines.map((line) => line.id))).toEqual([
      [2.2, "第一句"],
      [2.8, "第二句"],
    ]);
    expect(resolve(tail.topics[0]?.lineIds ?? [])).toEqual([
      [2.2, "第一句"],
      [2.8, "第二句"],
    ]);
  });

  test("同一时间、同一文本、不同说话人：两行各有独立 id，只选一行时只解析那一行", async () => {
    const root = makeTmpDir("project-analysis-");
    const notesRoot = join(root, "notes");
    const cacheRoot = join(root, "cache");
    const source = join(root, "src.mp4");
    makeMp4(source, 4);
    const twoSpeakers: AsrEngine = {
      id: "local",
      modelId: "fake-asr",
      run: async () => ({
        transcript: {
          speakers: [
            { id: "s1" as SpeakerId, name: "说话人 1", color: "#888888" },
            { id: "s2" as SpeakerId, name: "说话人 2", color: "#666666" },
          ],
          // 抢话：两个人同一时间说了同一句话，去重只删「严格更短」的行，这两行都会留下
          utterances: [
            { start: 0.2, end: 0.6, speakerId: "s1" as SpeakerId, text: "第一句。" },
            { start: 0.2, end: 0.6, speakerId: "s2" as SpeakerId, text: "第一句。" },
          ],
        },
        chunks: [{ index: 1, start: 0, end: 2 }],
        timings: {},
        cacheHits: [],
        engine: "local",
        modelId: "fake-asr",
      }),
    };

    const analyzed = await analyzeVideoRange({
      videoPath: source,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 2,
      endpoint,
      client: fakeClient({ start: 0, end: 2 }),
      asrEngine: twoSpeakers,
    });
    const lines = subtitleLinesFrom(
      loadVideoData(analyzed.outputDir, { id: analyzed.videoId as VideoId, title: "" }),
    );

    expect(lines.map((line) => line.speaker)).toEqual(["说话人 1", "说话人 2"]);
    // 时间与文本相同，但它们是两行字幕：id 撞在一起时弹窗只能同时勾选、同时取消
    expect(new Set(lines.map((line) => line.id)).size).toBe(2);
    expect(analyzed.topics[0]?.lineIds).toHaveLength(2);
    expect(new Set(analyzed.topics[0]?.lineIds ?? []).size).toBe(2);
    // 只提交其中一行时，另一行不能被一起带上
    const picked = analyzed.topics[0]?.lineIds[0] ?? "";
    expect(lines.filter((line) => line.id === picked).map((line) => line.speaker)).toHaveLength(1);
  });

  test("旧数据里字段完全重复的两行：仍各有独立 id，弹窗勾一行不联动另一行", async () => {
    const root = makeTmpDir("project-analysis-");
    const notesRoot = join(root, "notes");
    const cacheRoot = join(root, "cache");
    const source = join(root, "src.mp4");
    makeMp4(source, 4);

    const first = await analyzeVideoRange({
      videoPath: source,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 2,
      endpoint,
      client: fakeClient({ start: 0, end: 2 }),
      asrEngine: fakeEngine([]),
    });

    // 旧版无条件追加留下的历史数据：同一句字幕在 video.json 里存了两份，字段完全一致
    const legacy = loadVideoData(first.outputDir, { id: first.videoId as VideoId, title: "" });
    const duplicated = [...legacy.transcript.utterances, { ...legacy.transcript.utterances[0]! }];
    writeVideoData(first.outputDir, {
      ...legacy,
      transcript: { ...legacy.transcript, utterances: duplicated },
    });

    const again = await analyzeVideoRange({
      videoPath: source,
      outputDir: first.outputDir,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 4,
      endpoint,
      client: fakeClient({ start: 0, end: 4 }),
      asrEngine: fakeEngine([]),
    });
    const lines = subtitleLinesFrom(
      loadVideoData(again.outputDir, { id: again.videoId as VideoId, title: "" }),
    );

    // 已有行原样保留（含历史重复行），重跑出来的同两行被判定为重复丢掉
    expect(lines.map((line) => [line.start, line.text])).toEqual([
      [0.2, "第一句"],
      [0.2, "第一句"],
      [0.8, "第二句"],
    ]);
    // 字段完全相同的两行必须各有 id：撞在一起时弹窗勾一行会同时勾上另一行
    expect(new Set(lines.map((line) => line.id)).size).toBe(3);
    expect(again.topics[0]?.lineIds).toHaveLength(3);
    expect(new Set(again.topics[0]?.lineIds ?? []).size).toBe(3);
    const picked = again.topics[0]?.lineIds[0] ?? "";
    expect(lines.filter((line) => line.id === picked)).toHaveLength(1);
  });

  test("模型给出区间外的时间段：夹回区间，夹不出就丢弃，不串到别的区间", async () => {
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
      client: fakeClient({ start: 0, end: 1 }),
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
      // 误用相对时间：0–1 不在 2–4 内，必须丢弃而不是映射到第一区间的字幕
      client: fakeClient({ start: 0, end: 1 }),
      asrEngine: fakeEngine(calls),
    });
    expect(second.topics).toEqual([]);
    const data = loadVideoData(second.outputDir, { id: second.videoId as VideoId, title: "" });
    expect(data.topics).toHaveLength(1);
    expect(data.transcript.utterances).toHaveLength(4);
  });

  test("同一区间再次分析：复用已有结果，不重复转写、不重复追加字幕与主题", async () => {
    const root = makeTmpDir("project-analysis-");
    const notesRoot = join(root, "notes");
    const cacheRoot = join(root, "cache");
    const source = join(root, "src.mp4");
    makeMp4(source, 2);
    const calls: { wavPath: string }[] = [];

    const first = await analyzeVideoRange({
      videoPath: source,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 2,
      endpoint,
      client: fakeClient({ start: 0, end: 1 }),
      asrEngine: fakeEngine(calls),
    });
    const again = await analyzeVideoRange({
      videoPath: source,
      outputDir: first.outputDir,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 2,
      endpoint,
      client: fakeClient({ start: 0, end: 1 }),
      asrEngine: fakeEngine(calls),
    });

    expect(again.addedLines).toBe(0);
    expect(again.topics.map((t) => t.id)).toEqual(first.topics.map((t) => t.id));
    expect(calls).toHaveLength(1);
    const data = loadVideoData(first.outputDir, { id: first.videoId as VideoId, title: "" });
    expect(data.transcript.utterances).toHaveLength(2);
    expect(data.topics).toHaveLength(1);
    expect(data.chunks).toHaveLength(1);
  });
});

describe("analyzeVideoRange：运行锁归属", () => {
  test("调用方传入的锁由调用方释放：管线返回后锁仍在，不会被同视频的另一个槽插队", async () => {
    const root = makeTmpDir("project-analysis-lock-");
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
      client: fakeClient({ start: 0, end: 2 }),
      asrEngine: fakeEngine(calls),
    });
    const lock = acquireVideoLock(first.outputDir);
    try {
      const second = await analyzeVideoRange({
        videoPath: source,
        outputDir: first.outputDir,
        notesRoot,
        cacheRoot,
        startSeconds: 2,
        endSeconds: 4,
        endpoint,
        client: fakeClient({ start: 2, end: 4 }),
        asrEngine: fakeEngine(calls),
        lock,
      });
      expect(second.topics.map((t) => t.title)).toEqual(["区间主题"]);
      expect(isVideoLocked(first.outputDir)).toBe(true);
    } finally {
      lock.release();
    }
    expect(isVideoLocked(first.outputDir)).toBe(false);
  });
});

describe("两步进度：#142 依赖的事件契约", () => {
  test("主题分析开始先发 done:0 的阶段事件，再发分块完成事件", async () => {
    const root = makeTmpDir("project-analysis-progress-");
    const notesRoot = join(root, "notes");
    const cacheRoot = join(root, "cache");
    const source = join(root, "src.mp4");
    makeMp4(source, 4);
    const progress: Array<{ step: string; done: number; total: number }> = [];

    await analyzeVideoRange({
      videoPath: source,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 2,
      endpoint,
      client: fakeClient({ start: 0, end: 2 }),
      asrEngine: fakeEngine([]),
      onProgress: (event) => progress.push({ step: event.step, done: event.done, total: event.total }),
    });

    // 执行器把 segment-topics 映射成第 2 步；事件名或起始时机一旦改动，队列 tab 会静默卡在第 1 步
    const steps = progress.filter((event) => event.step === "segment-topics");
    expect(steps[0]).toEqual({ step: "segment-topics", done: 0, total: 1 });
    expect(steps.at(-1)).toEqual({ step: "segment-topics", done: 1, total: 1 });
    expect(progress.some((event) => event.step === "transcribe")).toBe(true);
  });
});
describe("analyzeVideoRange：跨次说话人对齐（#145）", () => {
  /** 整段按「本次说话总时长」排名，区间只切到另一个人的大段发言：同一个人的编号倒过来。 */
  function rankInvertingEngine(): AsrEngine {
    let calls = 0;
    return {
      id: "local",
      modelId: "fake-asr",
      run: async () => {
        const range = calls > 0;
        calls += 1;
        if (!range) {
          return {
            transcript: {
              speakers: [
                { id: "speaker-1" as SpeakerId, name: "说话人1", color: "#4f8ef7" },
                { id: "speaker-2" as SpeakerId, name: "说话人2", color: "#e8764c" },
              ],
              // 整段：说话人1 靠大量短句排第一，说话人2 只有一段长发言
              utterances: [
                { start: 0.2, end: 1.1, speakerId: "speaker-1" as SpeakerId, text: "我们先看这一期的素材。" },
                { start: 1.2, end: 2.2, speakerId: "speaker-1" as SpeakerId, text: "然后逐条对一遍字幕。" },
                { start: 2.2, end: 3.6, speakerId: "speaker-2" as SpeakerId, text: "今天讲一下素材整理的方法。" },
              ],
            },
            chunks: [{ index: 1, start: 0, end: 4 }],
            timings: {},
            cacheHits: [],
            engine: "local",
            modelId: "fake-asr",
          };
        }
        return {
          transcript: {
            // 区间里只有这个人的发言：本区间排名把他排成 speaker-1
            speakers: [{ id: "speaker-1" as SpeakerId, name: "说话人1", color: "#4f8ef7" }],
            utterances: [
              { start: 0.2, end: 1.6, speakerId: "speaker-1" as SpeakerId, text: "今天讲一下素材整理的方法。" },
              { start: 1.8, end: 2.6, speakerId: "speaker-1" as SpeakerId, text: "字幕校对就按时间轴来。" },
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

  test("整段 speaker-2、区间 speaker-1 的同一行只留一行，新行不重复追加", async () => {
    const root = makeTmpDir("project-analysis-");
    const notesRoot = join(root, "notes");
    const cacheRoot = join(root, "cache");
    const source = join(root, "src.mp4");
    makeMp4(source, 4);
    const engine = rankInvertingEngine();

    const whole = await analyzeVideoRange({
      videoPath: source,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 4,
      endpoint,
      client: fakeClient({ start: 0, end: 4 }),
      asrEngine: engine,
    });
    const beforeLines = subtitleLinesFrom(loadVideoData(whole.outputDir, { id: whole.videoId as VideoId, title: "" }));

    const range = await analyzeVideoRange({
      videoPath: source,
      outputDir: whole.outputDir,
      notesRoot,
      cacheRoot,
      startSeconds: 2,
      endSeconds: 4,
      endpoint,
      client: fakeClient({ start: 2, end: 4 }),
      asrEngine: engine,
    });

    const data = loadVideoData(range.outputDir, { id: range.videoId as VideoId, title: "" });
    // 重复的那一行不追加；真正的新行照常追加
    expect(range.addedLines).toBe(1);
    expect(data.transcript.utterances.map((u) => [u.start, u.text])).toEqual([
      [0.2, "我们先看这一期的素材。"],
      [1.2, "然后逐条对一遍字幕。"],
      [2.2, "今天讲一下素材整理的方法。"],
      [3.8, "字幕校对就按时间轴来。"],
    ]);

    const lines = subtitleLinesFrom(data);
    // 一一对应：整段已有的行 id 一个都没变，弹窗的默认建议行不会因为重跑多出一份
    expect(lines.filter((line) => line.text === "今天讲一下素材整理的方法。")).toHaveLength(1);
    for (const line of beforeLines) expect(lines.some((l) => l.id === line.id)).toBe(true);
    expect(new Set(lines.map((line) => line.id)).size).toBe(lines.length);
    expect(new Set(range.topics[0]?.lineIds ?? []).size).toBe(range.topics[0]?.lineIds.length ?? 0);

    // 对齐后的新行沿用来源视频的稳定身份：这个人整段里是 speaker-2
    const appended = data.transcript.utterances.find((u) => u.text === "字幕校对就按时间轴来。");
    expect(appended?.speakerId as string | undefined).toBe("speaker-2");
    // 局部编号 speaker-1 已被映射走，不该在说话人列表里留下空壳
    expect(data.transcript.speakers.map((s) => s.id as string).sort()).toEqual(["speaker-1", "speaker-2"]);
    expect(lines.filter((line) => line.text === "字幕校对就按时间轴来。").map((line) => line.speaker)).toEqual(["说话人2"]);
  });
});

describe("analyzeVideoRange：证明不了的局部编号不落盘成别人的身份（#145）", () => {
  /** 整段两人；区间里冒出第三个人，局部编号撞上整段的 speaker-1。 */
  function thirdPersonEngine(): AsrEngine {
    let calls = 0;
    return {
      id: "local",
      modelId: "fake-asr",
      run: async () => {
        const range = calls > 0;
        calls += 1;
        if (!range) {
          return {
            transcript: {
              speakers: [
                { id: "speaker-1" as SpeakerId, name: "说话人1", color: "#4f8ef7" },
                { id: "speaker-2" as SpeakerId, name: "说话人2", color: "#e8764c" },
              ],
              utterances: [
                { start: 0.2, end: 1.1, speakerId: "speaker-1" as SpeakerId, text: "我们先看这一期的素材。" },
                { start: 1.2, end: 2.2, speakerId: "speaker-1" as SpeakerId, text: "然后逐条对一遍字幕。" },
                { start: 2.2, end: 3.6, speakerId: "speaker-2" as SpeakerId, text: "今天讲一下素材整理的方法。" },
              ],
            },
            chunks: [{ index: 1, start: 0, end: 4 }],
            timings: {},
            cacheHits: [],
            engine: "local",
            modelId: "fake-asr",
          };
        }
        return {
          transcript: {
            // 局部 speaker-1 是本区间里说话最多的那个人（整段的 speaker-2），
            // 局部 speaker-2 是刚进来的第三个人：他与整段任何行都对不上，证明不了身份
            speakers: [
              { id: "speaker-1" as SpeakerId, name: "说话人1", color: "#4f8ef7" },
              { id: "speaker-2" as SpeakerId, name: "说话人2", color: "#e8764c" },
            ],
            utterances: [
              { start: 0.2, end: 1.6, speakerId: "speaker-1" as SpeakerId, text: "今天讲一下素材整理的方法。" },
              { start: 1.6, end: 1.9, speakerId: "speaker-1" as SpeakerId, text: "字幕校对就按时间轴来。" },
              { start: 0.5, end: 1.5, speakerId: "speaker-2" as SpeakerId, text: "我是刚进来的第三个人。" },
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

  test("区间新人的局部编号与整段既有编号撞车：另铸新号，不并进别人的身份", async () => {
    const root = makeTmpDir("project-analysis-");
    const notesRoot = join(root, "notes");
    const cacheRoot = join(root, "cache");
    const source = join(root, "src.mp4");
    makeMp4(source, 4);
    const engine = thirdPersonEngine();

    const whole = await analyzeVideoRange({
      videoPath: source,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 4,
      endpoint,
      client: fakeClient({ start: 0, end: 4 }),
      asrEngine: engine,
    });
    const range = await analyzeVideoRange({
      videoPath: source,
      outputDir: whole.outputDir,
      notesRoot,
      cacheRoot,
      startSeconds: 2,
      endSeconds: 4,
      endpoint,
      client: fakeClient({ start: 2, end: 4 }),
      asrEngine: engine,
      // 合成静音上算不出可信声纹：显式给「没有嵌入」，验证的是「证不出来 → 铸号」这条
      voiceprintDeps: { embedSpans: ({ spans }: { spans: ReadonlyArray<{ start: number; end: number }> }) => spans.map((span) => ({ ...span, v: null })) },
      referenceAudio: { samples: new Float32Array(16000 * 4), sampleRate: 16000 },
    });

    const data = loadVideoData(range.outputDir, { id: range.videoId as VideoId, title: "" });
    const third = data.transcript.utterances.find((u) => u.text === "我是刚进来的第三个人。");
    const followedUp = data.transcript.utterances.find((u) => u.text === "字幕校对就按时间轴来。");
    // 已证明的发言仍归整段的 speaker-2
    expect(followedUp?.speakerId as string | undefined).toBe("speaker-2");
    // 证明不了的新人不能落到 speaker-1 / speaker-2 头上
    expect(third?.speakerId as string | undefined).not.toBe("speaker-1");
    expect(third?.speakerId as string | undefined).not.toBe("speaker-2");
    const names = data.transcript.speakers.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(data.transcript.speakers.map((s) => s.id as string)).toContain(third?.speakerId as string);
    // 重复行仍然只留一份
    expect(range.addedLines).toBe(2);
  });
});

describe("analyzeVideoRange：区间全是新内容（对齐无证据）", () => {
  test("映射为空时新行全部保留，说话人正常登记且不与既有身份混名", async () => {
    const root = makeTmpDir("project-analysis-");
    const notesRoot = join(root, "notes");
    const cacheRoot = join(root, "cache");
    const source = join(root, "src.mp4");
    makeMp4(source, 4);
    let calls = 0;
    const engine: AsrEngine = {
      id: "local",
      modelId: "fake-asr",
      run: async () => {
        const range = calls > 0;
        calls += 1;
        return {
          transcript: {
            speakers: [{ id: "speaker-1" as SpeakerId, name: "说话人1", color: "#4f8ef7" }],
            utterances: range
              ? [{ start: 0.2, end: 1.5, speakerId: "speaker-1" as SpeakerId, text: "这一段全新的内容没有旧行可以对上。" }]
              : [{ start: 0.2, end: 1.5, speakerId: "speaker-1" as SpeakerId, text: "我们先看这一期的素材。" }],
          },
          chunks: [{ index: 1, start: 0, end: 2 }],
          timings: {},
          cacheHits: [],
          engine: "local",
          modelId: "fake-asr",
        };
      },
    };

    const whole = await analyzeVideoRange({
      videoPath: source,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 2,
      endpoint,
      client: fakeClient({ start: 0, end: 2 }),
      asrEngine: engine,
    });
    const range = await analyzeVideoRange({
      videoPath: source,
      outputDir: whole.outputDir,
      notesRoot,
      cacheRoot,
      startSeconds: 2,
      endSeconds: 4,
      endpoint,
      client: fakeClient({ start: 2, end: 4 }),
      asrEngine: engine,
      voiceprintDeps: { embedSpans: ({ spans }: { spans: ReadonlyArray<{ start: number; end: number }> }) => spans.map((span) => ({ ...span, v: null })) },
      referenceAudio: { samples: new Float32Array(16000 * 4), sampleRate: 16000 },
    });

    const data = loadVideoData(range.outputDir, { id: range.videoId as VideoId, title: "" });
    // 时间对不上（整段 0.2–1.5、区间 2.2–3.5），文本也不同：没有证据就保留
    expect(range.addedLines).toBe(1);
    expect(data.transcript.utterances.map((u) => u.text)).toEqual([
      "我们先看这一期的素材。",
      "这一段全新的内容没有旧行可以对上。",
    ]);
    const names = data.transcript.speakers.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(data.transcript.speakers).toHaveLength(2);
  });
});

describe("analyzeVideoRange：区间分离簇数与整段不同（#145 QA）", () => {
  /** 整段 3 人；区间只分出 1 个簇（真实分离模型在短音频上就是这样把多人并进一个编号）。 */
  function mergedClusterEngine(): AsrEngine {
    let calls = 0;
    return {
      id: "local",
      modelId: "fake-asr",
      run: async () => {
        const range = calls > 0;
        calls += 1;
        if (!range) {
          return {
            transcript: {
              speakers: [
                { id: "speaker-1" as SpeakerId, name: "说话人1", color: "#4f8ef7" },
                { id: "speaker-2" as SpeakerId, name: "说话人2", color: "#e8764c" },
                { id: "speaker-3" as SpeakerId, name: "说话人3", color: "#5faa55" },
              ],
              utterances: [
                { start: 0.2, end: 1.1, speakerId: "speaker-1" as SpeakerId, text: "我们先看这一期的素材。" },
                { start: 1.2, end: 2.5, speakerId: "speaker-2" as SpeakerId, text: "然后逐条对一遍字幕。" },
                { start: 4.2, end: 6.6, speakerId: "speaker-3" as SpeakerId, text: "今天讲一下素材整理的方法。" },
                { start: 6.8, end: 7.9, speakerId: "speaker-2" as SpeakerId, text: "字幕校对就按时间轴来。" },
              ],
            },
            chunks: [{ index: 1, start: 0, end: 8 }],
            timings: {},
            cacheHits: [],
            engine: "local",
            modelId: "fake-asr",
          };
        }
        return {
          transcript: {
            // 6 个整段簇被并成 1 个局部编号：它的行分别来自整段的两个人，身份证不出来
            speakers: [{ id: "speaker-1" as SpeakerId, name: "说话人1", color: "#4f8ef7" }],
            utterances: [
              { start: 0.2, end: 2.6, speakerId: "speaker-1" as SpeakerId, text: "今天讲一下素材整理的方法。" },
              { start: 2.8, end: 3.9, speakerId: "speaker-1" as SpeakerId, text: "字幕校对就按时间轴来。" },
            ],
          },
          chunks: [{ index: 1, start: 0, end: 4 }],
          timings: {},
          cacheHits: [],
          engine: "local",
          modelId: "fake-asr",
        };
      },
    };
  }

  test("同一句话被重跑写出第二遍：按内容判重，不追加行、不加说话人、不添主题", async () => {
    const root = makeTmpDir("project-analysis-");
    const notesRoot = join(root, "notes");
    const cacheRoot = join(root, "cache");
    const source = join(root, "src.mp4");
    makeMp4(source, 8);
    const engine = mergedClusterEngine();

    const whole = await analyzeVideoRange({
      videoPath: source,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 8,
      endpoint,
      client: fakeClient({ start: 0, end: 8 }),
      asrEngine: engine,
    });
    const range = await analyzeVideoRange({
      videoPath: source,
      outputDir: whole.outputDir,
      notesRoot,
      cacheRoot,
      startSeconds: 4,
      endSeconds: 8,
      endpoint,
      client: fakeClient({ start: 4, end: 8 }),
      asrEngine: engine,
    });

    const data = loadVideoData(range.outputDir, { id: range.videoId as VideoId, title: "" });
    expect(range.addedLines).toBe(0);
    expect(data.transcript.utterances.map((u) => u.text)).toEqual([
      "我们先看这一期的素材。",
      "然后逐条对一遍字幕。",
      "今天讲一下素材整理的方法。",
      "字幕校对就按时间轴来。",
    ]);
    // 说话人 3 位不变：没有新增内容就不该铸新号
    expect(data.transcript.speakers).toHaveLength(3);
    // 主题不变：区间没有新内容就不再跑主题分析，不重复建卡、也不产生新的待确认主题
    expect(data.topics).toHaveLength(1);
    expect(range.topics).toEqual([]);

    const lines = subtitleLinesFrom(data);
    const contents = lines.filter((line) => line.start >= 4 && line.start < 8).map((line) => `${line.start}|${line.text}`);
    expect(new Set(contents).size).toBe(contents.length);
  });
});

describe("analyzeVideoRange：声纹把区间局部簇归回既有说话人（#145 r91j）", () => {
  /** 同一套向量：base 决定「像谁」。 */
  function voice(base: number): number[] {
    const out = new Array<number>(8).fill(0);
    out[base] = 1;
    return out;
  }

  /** 让两个单位向量的余弦等于 target。 */
  function blend(base: number, target: number): number[] {
    const a = voice(base);
    return a.map((value, i) => (i === base ? target : i === (base + 1) % 8 ? Math.sqrt(Math.max(0, 1 - target * target)) : value));
  }

  test("真实新人：声纹不像任何既有说话人且种子够 → 仍然建新号", async () => {
    const root = makeTmpDir("project-analysis-");
    const notesRoot = join(root, "notes");
    const cacheRoot = join(root, "cache");
    const source = join(root, "src.mp4");
    makeMp4(source, 8);
    let calls = 0;
    const engine: AsrEngine = {
      id: "local",
      modelId: "fake-asr",
      run: async () => {
        const range = calls > 0;
        calls += 1;
        return {
          transcript: {
            speakers: [{ id: "speaker-1" as SpeakerId, name: "说话人1", color: "#4f8ef7" }],
            utterances: range
              ? [{ start: 0.2, end: 4.2, speakerId: "speaker-1" as SpeakerId, text: "区间里真正的新人开口。" }]
              : [{ start: 0.2, end: 3.2, speakerId: "speaker-1" as SpeakerId, text: "整段原有的一句话。" }],
          },
          chunks: [{ index: 1, start: 0, end: 4 }],
          timings: {},
          cacheHits: [],
          engine: "local",
          modelId: "fake-asr",
        };
      },
    };
    let call = 0;
    const whole = await analyzeVideoRange({
      videoPath: source,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 4,
      endpoint,
      client: fakeClient({ start: 0, end: 4 }),
      asrEngine: engine,
    });
    const range = await analyzeVideoRange({
      videoPath: source,
      outputDir: whole.outputDir,
      notesRoot,
      cacheRoot,
      startSeconds: 4,
      endSeconds: 8,
      endpoint,
      client: fakeClient({ start: 4, end: 8 }),
      asrEngine: engine,
      voiceprintDeps: {
        embedSpans: ({ spans }: { spans: ReadonlyArray<{ start: number; end: number }> }) =>
          // 第一次调用是既有说话人参考（向量基 0），第二次是区间局部簇（向量基 4，余弦 0）
          spans.map((span) => ({ start: span.start, end: span.end, v: voice(call++ === 0 ? 0 : 4) })),
      },
      referenceAudio: { samples: new Float32Array(16000 * 8), sampleRate: 16000 },
    });
    const data = loadVideoData(range.outputDir, { id: range.videoId as VideoId, title: "" });
    // 余弦 0 且区间行 4 秒 ≥ 3 秒种子闸：允许建新号，旧编号不受影响
    expect(data.transcript.speakers.map((s) => s.id as string)).toEqual(["speaker-1", "speaker-2"]);
    expect(data.transcript.utterances.find((u) => u.text === "区间里真正的新人开口。")?.speakerId as string).toBe("speaker-2");
  });

  test("区间局部编号与既有行对不上文本，但声纹像同一个人：不铸新号", async () => {
    const root = makeTmpDir("project-analysis-");
    const notesRoot = join(root, "notes");
    const cacheRoot = join(root, "cache");
    const source = join(root, "src.mp4");
    makeMp4(source, 8);
    let calls = 0;
    const engine: AsrEngine = {
      id: "local",
      modelId: "fake-asr",
      run: async () => {
        const range = calls > 0;
        calls += 1;
        return {
          transcript: {
            speakers: [{ id: "speaker-1" as SpeakerId, name: "说话人1", color: "#4f8ef7" }],
            utterances: range
              ? [{ start: 0.2, end: 3.2, speakerId: "speaker-1" as SpeakerId, text: "区间里重新识别的一句话。" }]
              : [{ start: 0.2, end: 3.2, speakerId: "speaker-1" as SpeakerId, text: "整段原有的一句话。" }],
          },
          chunks: [{ index: 1, start: 0, end: 4 }],
          timings: {},
          cacheHits: [],
          engine: "local",
          modelId: "fake-asr",
        };
      },
    };
    // 参考（整段）与区间（局部）嵌入都是同一个人：cos=0.86
    const embedCalls: number[] = [];
    const voiceprintDeps = {
      embedSpans: ({ spans }: { spans: ReadonlyArray<{ start: number; end: number }> }) => {
        embedCalls.push(spans.length);
        return spans.map((span) => ({ start: span.start, end: span.end, v: blend(0, 0.86) }));
      },
    };
    const whole = await analyzeVideoRange({
      videoPath: source,
      notesRoot,
      cacheRoot,
      startSeconds: 0,
      endSeconds: 4,
      endpoint,
      client: fakeClient({ start: 0, end: 4 }),
      asrEngine: engine,
    });
    const range = await analyzeVideoRange({
      videoPath: source,
      outputDir: whole.outputDir,
      notesRoot,
      cacheRoot,
      startSeconds: 4,
      endSeconds: 8,
      endpoint,
      client: fakeClient({ start: 4, end: 8 }),
      asrEngine: engine,
      voiceprintDeps,
      referenceAudio: { samples: new Float32Array(16000 * 8), sampleRate: 16000 },
    });
    const data = loadVideoData(range.outputDir, { id: range.videoId as VideoId, title: "" });
    // 没有铸新号：说话人仍是整段那 1 位
    expect(data.transcript.speakers.map((s) => s.id as string)).toEqual(["speaker-1"]);
    expect(data.transcript.utterances.find((u) => u.text === "区间里重新识别的一句话。")?.speakerId as string).toBe("speaker-1");
    expect(embedCalls.length).toBeGreaterThanOrEqual(2);
  });
});
