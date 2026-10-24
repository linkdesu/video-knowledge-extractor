import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { ChatMessage, LlmEndpoint, Progress, SegmentTopicsInput } from "../core/steps";
import { segmentTopics } from "./segment-topics";
import type { SpeakerId, Transcript, Utterance } from "../core/types";

type Received = {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

let server: Server<undefined> | undefined;
let received: Received[] = [];

/** 每次用新的临时缓存目录：固定路径会让上一轮的文件变成命中，测试互相污染。 */
function tempCacheDir(): string {
  return mkdtempSync(`${tmpdir()}/seg-topics-`);
}
let endpoint: LlmEndpoint = { baseUrl: "", apiKey: "k-test", model: "m-test" };

let rawMerge: string | undefined;
let rawChunk: string | undefined;

function respond(body: Record<string, unknown>): string {
  const user = (body["messages"] as ChatMessage[]).find((m) => m.role === "user")?.content ?? "";
  const content = (payload: string) => JSON.stringify({ choices: [{ message: { content: payload } }] });
  if (user.startsWith("视频共")) {
    if (rawMerge !== undefined) return content(rawMerge);
  } else if (rawChunk !== undefined) {
    return content(rawChunk);
  }
  if (user.startsWith("视频共")) {
    const payload = JSON.stringify({
      topics: [
        {
          title: "FireRed 引擎",
          summary: "两个块里的同一主题",
          segments: [
            { start: 10, end: 20 },
            { start: 19.5, end: 9999 },
            { start: -3, end: 5 },
            { start: "x", end: 5 },
          ],
        },
        { title: "", segments: [{ start: 0, end: 1 }] },
      ],
    });
    return JSON.stringify({ choices: [{ message: { content: payload } }] });
  }
  const idx = Number(user.match(/\[([0-9.]+)-/)?.[1] ?? 0);
  const payload = JSON.stringify({
    topics: [
      {
        title: `FireRed 引擎 块${idx}`,
        summary: "候选",
        segments: [{ start: idx === 0 ? 10 : 20, end: idx === 0 ? 15 : 25 }],
      },
    ],
  });
  return JSON.stringify({ choices: [{ message: { content: payload } }] });
}

function startServer(): void {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const body = JSON.parse(await req.text());
      received.push({ path: url.pathname, headers, body });
      return new Response(respond(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  endpoint = { baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k-test", model: "m-test" };
}

afterAll(() => server?.stop(true));

const utt = (start: number, end: number, text: string): Utterance => ({
  start,
  end,
  speakerId: "s1" as SpeakerId,
  text,
});

function makeInput(cacheDir: string, onProgress?: (p: Progress) => void): SegmentTopicsInput {
  const transcript: Transcript = {
    speakers: [{ id: "s1" as SpeakerId, name: "说话人1", color: "#fff" }],
    utterances: [
      utt(10, 12, "第一块的话"),
      utt(20, 22, "第二块的话"),
    ],
  };
  const chunks = [
    { index: 0, start: 0, end: 18 },
    { index: 1, start: 18, end: 30 },
  ];
  return {
    transcript,
    chunks,
    endpoint,
    cacheDir,
    ...(onProgress !== undefined ? { onProgress } : {}),
  };
}

const isChunkReq = (r: Received) =>
  (r.body["messages"] as ChatMessage[]).some((m) => m.content.startsWith("该块范围"));
const isMergeReq = (r: Received) =>
  (r.body["messages"] as ChatMessage[]).some((m) => m.content.startsWith("视频共"));

describe("segmentTopics", () => {
  test("分块候选 + 全局合并，时间段被清洗、夹紧、合并，主题按首段排序并编号", async () => {
    startServer();
    received = [];
    const progress: Progress[] = [];
    const { topics } = await segmentTopics(makeInput(tempCacheDir(), (p) => progress.push(p)));

    expect(received.length).toBe(3);
    expect(received.filter(isChunkReq).length).toBe(2);
    expect(received.filter(isMergeReq).length).toBe(1);

    expect(topics.length).toBe(1);
    const topic = topics[0];
    expect(topic).toBeDefined();
    expect(topic?.id as string).toBe("topic-1");
    expect(topic?.title).toBe("FireRed 引擎");
    // 负值起点夹到 0；越界终点夹到字幕末尾 22；重叠时间段（19.5-22 与 10-20）合并
    expect(topic?.segments).toEqual([
      { start: 0, end: 5 },
      { start: 10, end: 22 },
    ]);
    expect(progress.length).toBe(2);
    expect(progress[0]?.done).toBe(1);
    expect(progress[1]?.done).toBe(2);
  });

  test("同一 cacheDir 第二次调用零 HTTP 请求", async () => {
    startServer();
    const cacheDir = tempCacheDir();
    received = [];
    const first = await segmentTopics(makeInput(cacheDir));
    expect(received.length).toBe(3);
    received = [];
    const second = await segmentTopics(makeInput(cacheDir));
    expect(received.length).toBe(0);
    expect(second.topics).toEqual(first.topics);
  });

  test("分块回复不是 topics 数组时抛错并指明块号", async () => {
    startServer();
    rawChunk = JSON.stringify({ title: "裸主题", segments: [{ start: 1, end: 2 }] });
    const promise = segmentTopics(makeInput(tempCacheDir()));
    await expect(promise).rejects.toThrow(/第 1 块主题分析失败/);
    rawChunk = undefined;
  });

  test("合并回复不是 topics 数组时抛错，且坏回复不进缓存", async () => {
    startServer();
    const cacheDir = tempCacheDir();
    rawMerge = JSON.stringify({ title: "单个主题直接成了顶层对象", summary: "", segments: [{ start: 1, end: 2 }] });
    await expect(segmentTopics(makeInput(cacheDir))).rejects.toThrow(/主题合并失败/);
    rawMerge = undefined;
    received = [];
    const { topics } = await segmentTopics(makeInput(cacheDir));
    expect(received.filter(isMergeReq).length).toBe(1);
    expect(topics.length).toBe(1);
  });

  test("合并后没有一个有效时间段时抛错", async () => {
    startServer();
    rawMerge = JSON.stringify({ topics: [{ title: "空主题", summary: "", segments: [] }] });
    await expect(segmentTopics(makeInput(tempCacheDir()))).rejects.toThrow(/没有一个带有效时间段/);
    rawMerge = undefined;
  });

  test("无字幕行的块不发请求", async () => {
    startServer();
    received = [];
    const input = makeInput(tempCacheDir());
    input.chunks = [
      { index: 0, start: 0, end: 5 },
      { index: 1, start: 18, end: 30 },
    ];
    await segmentTopics(input);
    expect(received.filter(isChunkReq).length).toBe(1);
    expect(received.filter(isMergeReq).length).toBe(1);
  });
});

describe("segmentTopics 术语表注入", () => {
  test("合并词表进入分块与合并提示词，冲突项单视频优先，词表变化使缓存失效", async () => {
    startServer();
    const cacheDir = tempCacheDir();
    received = [];
    await segmentTopics({
      ...makeInput(cacheDir),
      corrections: {
        global: [
          { from: "old", to: "Old" },
          { from: "plain", to: "Plain" },
        ],
        video: [{ from: "old", to: "Video" }],
      },
    });
    const systems = received.map(
      (r) => (r.body["messages"] as ChatMessage[]).find((m) => m.role === "system")?.content ?? "",
    );
    expect(systems.length).toBe(3);
    for (const system of systems) {
      expect(system).toContain("- old → Video");
      expect(system).toContain("- plain → Plain");
      expect(system).not.toContain("Old");
    }

    // 词表变了：提示词哈希变化，旧缓存不能复用
    received = [];
    await segmentTopics({
      ...makeInput(cacheDir),
      corrections: { global: [{ from: "plain", to: "Changed" }], video: [] },
    });
    expect(received.length).toBe(3);
  });
});
