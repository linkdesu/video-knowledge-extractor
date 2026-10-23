import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cacheKey, cachePath, hashJson } from "../core/cache";
import { OUTPUT_MANIFEST } from "../core/outputs";
import type { LlmClient } from "../core/steps";
import type { CorrectionList, SpeakerId, Transcript, Topic, Utterance, Video } from "../core/types";
import { generateNotes, noteSystemPrompt, renderIndexMarkdown, renderTopicMarkdown } from "./generate-notes";

const corrections: CorrectionList = {
  global: [{ from: "skill", to: "SQL" }],
  video: [],
};
const endpoint = { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "test-model" };

function makeClient(points: string[], calls: number[]): LlmClient {
  return {
    model: endpoint.model,
    chat: async () => {
      calls.push(1);
      return JSON.stringify({ keyPoints: points });
    },
  };
}

function makeThrowingClient(calls: number[]): LlmClient {
  return {
    model: endpoint.model,
    chat: async () => {
      calls.push(1);
      throw new Error("LLM 端点不可用");
    },
  };
}

describe("renderTopicMarkdown", () => {
  test("标题、摘要、要点、正文按时间顺序、时间段标题链接切片", () => {
    const topic: Topic = {
      id: "t1" as never,
      title: "主题A",
      summary: "这是摘要",
      segments: [
        { start: 120, end: 150 },
        { start: 15, end: 20 },
      ],
    };
    const utterances: Utterance[] = [
      { start: 15, end: 17, speakerId: "sp1" as SpeakerId, text: "开头" },
      { start: 120, end: 126, speakerId: "sp1" as SpeakerId, text: "第一句" },
      { start: 127, end: 130, speakerId: "sp2" as SpeakerId, text: "第二句" },
      { start: 131, end: 134, speakerId: "sp1" as SpeakerId, text: "第三句" },
    ];
    const clips = [
      { topicId: "t1" as never, segment: { start: 12, end: 150 }, path: "/out/主题A/01-00-00-12-00-02-30.mp4" },
    ];
    const names = new Map<SpeakerId, string>([
      ["sp1" as SpeakerId, "说话人1"],
      ["sp2" as SpeakerId, "说话人2"],
    ]);
    const md = renderTopicMarkdown(topic, utterances, ["要点一", "要点二"], clips, names);
    expect(md).toBe(
      [
        "# 主题A",
        "",
        "这是摘要",
        "",
        "## 要点",
        "- 要点一",
        "- 要点二",
        "",
        "## 正文",
        "",
        "### [00:00:15 - 00:00:20](01-00-00-12-00-02-30.mp4)",
        "**说话人1**: 开头",
        "",
        "### [00:02:00 - 00:02:30](01-00-00-12-00-02-30.mp4)",
        "**说话人1**: 第一句",
        "**说话人2**: 第二句",
        "**说话人1**: 第三句",
        "",
      ].join("\n"),
    );
    expect(renderTopicMarkdown(topic, utterances, ["要点一", "要点二"], clips, names)).toBe(md);
  });

  test("未登记的名字回退到 id", () => {
    const topic: Topic = {
      id: "t2" as never,
      title: "回退",
      summary: "",
      segments: [{ start: 0, end: 5 }],
    };
    const utterances = [
      { start: 1, end: 2, speakerId: "sp9" as SpeakerId, text: "只有一句" },
    ];
    const names = new Map<SpeakerId, string>();
    const md = renderTopicMarkdown(topic, utterances, [], [], names);
    expect(md).toBe(
      [
        "# 回退",
        "",
        "## 要点",
        "",
        "## 正文",
        "",
        "### [00:00:00 - 00:00:05]()",
        "**sp9**: 只有一句",
        "",
      ].join("\n"),
    );
  });

  test("空摘要与空要点时布局不变", () => {
    const topic: Topic = {
      id: "t3" as never,
      title: "无摘要",
      summary: "",
      segments: [{ start: 0, end: 5 }],
    };
    const md = renderTopicMarkdown(topic, [], [], [], new Map());
    expect(md).toBe(["# 无摘要", "", "## 要点", "", "## 正文", "", "### [00:00:00 - 00:00:05]()", ""].join("\n"));
  });
});

describe("renderIndexMarkdown", () => {
  test("每主题一行，时间顺序，附切片链接", () => {
    const video: Video = {
      id: "v1" as never,
      title: "测试视频",
      sourcePath: "/no/such/file.mp4",
      durationSeconds: 600,
      outputDir: "/no/such/out",
    };
    const topics: Topic[] = [
      { id: "t2" as never, title: "后段", summary: "后段摘要", segments: [{ start: 300, end: 320 }] },
      { id: "t1" as never, title: "前段", summary: "前段摘要", segments: [{ start: 10, end: 20 }] },
    ];
    const dirs = new Map([
      ["t1" as never, "前段"],
      ["t2" as never, "后段"],
    ]);
    const notes = [
      {
        topicId: "t1" as never,
        markdown: "",
        clips: [{ topicId: "t1" as never, segment: { start: 7, end: 20 }, path: "/no/such/out/前段/01-00-00-07-00-00-20.mp4" }],
      },
      {
        topicId: "t2" as never,
        markdown: "",
        clips: [{ topicId: "t2" as never, segment: { start: 297, end: 320 }, path: "/no/such/out/后段/01-00-04-57-00-05-20.mp4" }],
      },
    ];
    const md = renderIndexMarkdown(video, topics, dirs, notes);
    expect(md).toBe(
      [
        "# 测试视频",
        "",
        "- [前段](./前段/topic.md) — 前段摘要 [切片](./前段/01-00-00-07-00-00-20.mp4)",
        "- [后段](./后段/topic.md) — 后段摘要 [切片](./后段/01-00-04-57-00-05-20.mp4)",
        "",
      ].join("\n"),
    );
    expect(renderIndexMarkdown(video, topics, dirs, notes)).toBe(md);
  });
});

function makeGenerateNotesFixture(): {
  input: Parameters<typeof generateNotes>[0];
  topic: Topic;
  utterances: Utterance[];
  cacheDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "vnote-notes-"));
  const out = join(root, "out");
  mkdirSync(out, { recursive: true });
  const cacheDir = join(out, ".cache");
  const video: Video = {
    id: "v1" as never,
    title: "测试视频",
    sourcePath: join(root, "missing.mp4"),
    durationSeconds: 600,
    outputDir: out,
  };
  const topic: Topic = {
    id: "t1" as never,
    title: "主题A",
    summary: "这是摘要",
    segments: [{ start: 120, end: 150 }],
  };
  const transcript: Transcript = {
    speakers: [],
    utterances: [{ start: 121, end: 126, speakerId: "s1" as SpeakerId, text: "第一句" }],
  };
  const input = {
    video,
    transcript,
    topics: [topic],
    dirNames: new Map([[topic.id, "主题A"]]),
    corrections,
    endpoint,
    cacheDir,
  };
  const utterances = transcript.utterances.filter(
    (u) => topic.segments.some((s) => u.end > s.start && u.start < s.end),
  );
  return { input, topic, utterances, cacheDir };
}

function noteCachePath(cacheDir: string, topic: Topic, utterances: Utterance[], input: Parameters<typeof generateNotes>[0]): string {
  const key = cacheKey("note", {
    topic: hashJson(topic),
    transcript: hashJson(utterances.map((u) => [u.start, u.end, u.speakerId, u.text])),
    prompt: hashJson(noteSystemPrompt(topic, utterances, input)),
    model: input.endpoint.model,
    corrections: hashJson(input.corrections),
  });
  return cachePath(cacheDir, key);
}

describe("generateNotes 要点缓存", () => {
  // 切片对不存在的源文件必然失败；只验证模型请求是否发出。
  test("缓存命中时不再请求模型，未命中时请求一次", async () => {
    const { input, topic, utterances, cacheDir } = makeGenerateNotesFixture();
    const calls: number[] = [];
    const client = makeClient(["要点一"], calls);
    await expect(generateNotes({ ...input, client })).rejects.toThrow();
    expect(calls.length).toBe(1);
    expect(readFileSync(noteCachePath(cacheDir, topic, utterances, input), "utf8").trim()).toBe('{"keyPoints":["要点一"]}');
    const calls2: number[] = [];
    const client2 = makeClient(["要点一"], calls2);
    await expect(generateNotes({ ...input, client: client2 })).rejects.toThrow();
    expect(calls2.length).toBe(0);
  });

  test("模型失败时向上抛出且不落缓存，重跑再次请求模型", async () => {
    const { input, topic, utterances, cacheDir } = makeGenerateNotesFixture();
    const calls: number[] = [];
    const client = makeThrowingClient(calls);
    await expect(generateNotes({ ...input, client })).rejects.toThrow(/LLM 端点不可用/);
    expect(calls.length).toBe(1);
    const path = noteCachePath(cacheDir, topic, utterances, input);
    expect(() => readFileSync(path, "utf8")).toThrow();
    const calls2: number[] = [];
    const client2 = makeThrowingClient(calls2);
    await expect(generateNotes({ ...input, client: client2 })).rejects.toThrow();
    expect(calls2.length).toBe(1);
  });

  test("键序无关：同输入不同键序得到同一文件路径", () => {
    const utterances: Utterance[] = [{ start: 1, end: 2, speakerId: "s1" as SpeakerId, text: "x" }];
    const topic: Topic = { id: "t1" as never, title: "t", summary: "s", segments: [{ start: 0, end: 1 }] };
    const input = {
      video: { id: "v1" as never, title: "v", sourcePath: "/s", durationSeconds: 1, outputDir: "/o" },
      transcript: { speakers: [], utterances },
      topics: [topic],
      dirNames: new Map([[topic.id, "t"]]),
      corrections,
      endpoint,
      cacheDir: "/c",
    } as Parameters<typeof generateNotes>[0];
    const prompt = hashJson(noteSystemPrompt(topic, utterances, input));
    const key = cacheKey("note", {
      topic: hashJson(topic),
      transcript: hashJson([{ start: 1 }]),
      prompt,
      model: "test-model",
      corrections: hashJson(corrections),
    });
    const key2 = cacheKey("note", {
      corrections: hashJson(corrections),
      model: "test-model",
      prompt,
      transcript: hashJson([{ start: 1 }]),
      topic: hashJson(topic),
    });
    expect(cachePath("/cache", key)).toBe(cachePath("/cache", key2));
  });
});

describe("generateNotes 中断", () => {
  test("模型失败时旧的 index.md 与旧主题目录逐字保留，且不写 manifest", async () => {
    const { input } = makeGenerateNotesFixture();
    const oldIndex = ["# 旧标题", "", "- [旧主题](./永不过期/topic.md) — 旧摘要", ""].join("\n");
    const oldTopicDir = join(input.video.outputDir, "永不过期");
    mkdirSync(oldTopicDir, { recursive: true });
    writeFileSync(join(oldTopicDir, "topic.md"), "# 旧主题\n");
    writeFileSync(join(input.video.outputDir, "index.md"), oldIndex);

    const calls: number[] = [];
    await expect(generateNotes({ ...input, client: makeThrowingClient(calls) })).rejects.toThrow(/LLM 端点不可用/);
    expect(calls.length).toBe(1);

    expect(readFileSync(join(input.video.outputDir, "index.md"), "utf8")).toBe(oldIndex);
    expect(readFileSync(join(oldTopicDir, "topic.md"), "utf8")).toBe("# 旧主题\n");
    expect(existsSync(join(input.video.outputDir, OUTPUT_MANIFEST))).toBe(false);
  });
});

describe("generateNotes 单文件主题切片（r33）", () => {
  test("part + concat 成 topic.mp4，记录 segmentOffsets，删旧编号切片", async () => {
    const root = mkdtempSync(join(tmpdir(), "vnote-topicmp4-"));
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    // 真 60 秒源：段 [10,20] 前移 2s 后 union [8,20]，偏移 10-8=2
    const src = join(root, "src.mp4");
    execFileSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "color=c=red:s=128x80:d=60", "-f", "lavfi", "-i", "sine=d=60", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src],
      { stdio: "pipe" },
    );
    const topic: Topic = {
      id: "t1" as never,
      title: "主题A",
      summary: "这是摘要",
      segments: [{ start: 10, end: 20 }],
    };
    const transcript: Transcript = {
      speakers: [],
      utterances: [{ start: 11, end: 12, speakerId: "s1" as SpeakerId, text: "内容" }],
    };
    const topicDir = join(out, "主题A");
    mkdirSync(topicDir, { recursive: true });
    // 旧编号切片：拼接成功后必须被删
    writeFileSync(join(topicDir, "01-00-00-07-00-00-20.mp4"), "legacy");
    const input = {
      video: { id: "v1" as never, title: "测试视频", sourcePath: src, durationSeconds: 60, outputDir: out },
      transcript,
      topics: [topic],
      dirNames: new Map([[topic.id, "主题A"]]),
      corrections,
      endpoint,
      cacheDir: join(out, ".cache"),
      client: makeClient(["要点一"], []),
    } as Parameters<typeof generateNotes>[0];
    const r = await generateNotes(input);
    expect(r.notes).toHaveLength(1);
    const clips = r.notes[0]!.clips;
    expect(clips).toHaveLength(1);
    expect(clips[0]!.path).toBe(join(topicDir, "topic.mp4"));
    expect(clips[0]!.segment).toEqual({ start: 8, end: 20 });
    expect(clips[0]!.segmentIndexes).toEqual([0]);
    expect(clips[0]!.segmentOffsets).toEqual([2]);
    // 单文件落盘、旧编号切片被删
    expect(existsSync(join(topicDir, "topic.mp4"))).toBe(true);
    expect(existsSync(join(topicDir, "01-00-00-07-00-00-20.mp4"))).toBe(false);
    // topic.md 的段标题链接 topic.mp4
    expect(readFileSync(join(topicDir, "topic.md"), "utf8")).toContain("](topic.mp4)");
  });
});
