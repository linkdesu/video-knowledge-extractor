import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmClient, LlmEndpoint } from "../core/steps";
import type { AsrEngine } from "../asr/engine";
import type { SpeakerId } from "../core/types";
import { runExtract } from "./extract";
import { AUDIO_UNDECODABLE_ERROR } from "../core/audio";
import { describeFailure } from "../core/failure-summary";
import { makeDecodableTs, makeUndecodableAacTs, makeVideoOnlyMp4 } from "../core/test-media";

const endpoint: LlmEndpoint = { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "test-model" };

function mkdtemp(): string {
  const dir = join(tmpdir(), "vnote-extract-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 用 ffmpeg 生成一段 2 秒的彩色条视频 + 静音音频（probe 与抽音都走真 ffmpeg）。 */
function makeMp4(path: string): void {
  execFileSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", "color=c=red:s=128x80:d=2", "-f", "lavfi", "-i", "sine=d=2", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path],
    { stdio: "pipe" },
  );
}

/** 假 LLM：主题划分与要点都直接给固定答案（extract 失败测试不会走到这里）。 */
function fakeClient(): LlmClient {
  return {
    model: endpoint.model,
    chat: async (_m, opts) => {
      if (!opts?.json) throw new Error("需要 json");
      return JSON.stringify({
        topics: [{ title: "foo", summary: "s", segments: [{ start: 0, end: 2 }] }],
        keyPoints: ["要点"],
      });
    },
  };
}

describe("runExtract 的火山标准版预检（ADR-0016 §6）", () => {
  const STANDARD_LOCAL_VIDEO_ERROR = "火山标准版只接受公网 URL；本地视频请改用极速版或本地 ASR";

  function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(values)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    return fn().finally(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }

  test("标准版 + 本地视频在 probeVideo 之前拒绝，不建目录、不做文件工作", async () => {
    const dir = mkdtemp();
    const notesRoot = join(dir, "notes");
    const cacheRoot = join(dir, "cache");
    const userData = join(dir, "user-data");
    // 故意指向不存在的文件：预检若不在最前，报错会变成 ffprobe 的文件错误
    const videoPath = join(dir, "in.mp4");
    await withEnv({ VNOTE_HOME: notesRoot, VNOTE_USER_DATA: userData }, async () => {
      const err = await runExtract({
        videoPath,
        notesRoot,
        endpoint,
        cacheRoot,
        client: fakeClient(),
        asr: { provider: "volcengine", mode: "standard", auth: { kind: "apiKey", apiKey: "test-key" } },
      }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(STANDARD_LOCAL_VIDEO_ERROR);
      // 输出目录、缓存目录、用户数据目录都还没被创建
      expect(existsSync(notesRoot)).toBe(false);
      expect(existsSync(cacheRoot)).toBe(false);
      expect(existsSync(userData)).toBe(false);
      expect(existsSync(join(dir, "video.json"))).toBe(false);
    });
  });

  test("极速版不被预检拒绝：失败点后移到读源文件", async () => {
    const dir = mkdtemp();
    const notesRoot = join(dir, "notes");
    const cacheRoot = join(dir, "cache");
    await withEnv({ VNOTE_HOME: notesRoot, VNOTE_USER_DATA: join(dir, "user-data") }, async () => {
      const err = await runExtract({
        videoPath: join(dir, "in.mp4"),
        notesRoot,
        endpoint,
        cacheRoot,
        client: fakeClient(),
        asr: { provider: "volcengine", mode: "flash", auth: { kind: "apiKey", apiKey: "test-key" } },
      }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toBe(STANDARD_LOCAL_VIDEO_ERROR);
    });
  });
});

/**
 * 容器可读但音轨解不出（加密/损坏的直播录像）：probe 给得出时长，预检必须在建目录、进 ASR 之前失败。
 */
describe("runExtract 的音轨可解码预检", () => {
  test("坏音轨 ts：建目录前失败，错误是可操作中文", async () => {
    const dir = mkdtemp();
    const videoPath = join(dir, "undecodable.ts");
    makeUndecodableAacTs(videoPath);
    const notesRoot = join(dir, "notes");
    const cacheRoot = join(dir, "cache");
    let prepared = 0;
    const err = await runExtract({
      videoPath,
      notesRoot,
      endpoint,
      cacheRoot,
      client: fakeClient(),
      asr: { provider: "local", modelDir: join(dir, "no-such-model") },
      onPrepared: async () => {
        prepared += 1;
      },
    }).catch((e) => e);
    expect((err as Error).message).toBe(AUDIO_UNDECODABLE_ERROR);
    expect(prepared).toBe(0);
    expect(existsSync(notesRoot)).toBe(false);
    expect(existsSync(cacheRoot)).toBe(false);
  });

  test("没有音频流的视频：保留 ffmpeg 原始失败，摘要仍是「没有可用的音视频轨道」", async () => {
    const dir = mkdtemp();
    const videoPath = join(dir, "silent.mp4");
    makeVideoOnlyMp4(videoPath);
    const err = await runExtract({
      videoPath,
      notesRoot: join(dir, "notes"),
      endpoint,
      cacheRoot: join(dir, "cache"),
      client: fakeClient(),
      asr: { provider: "local", modelDir: join(dir, "no-such-model") },
    }).catch((e) => e);
    expect((err as Error).message).toContain("does not contain any stream");
    expect(describeFailure((err as Error).message)).toBe("该文件没有可用的音视频轨道");
  });

  test("干净 .ts 不被预检误杀：照常走完导入", async () => {
    const dir = mkdtemp();
    const videoPath = join(dir, "clean.ts");
    makeDecodableTs(videoPath);
    const speaker = { id: "sp1" as SpeakerId, name: "说话人1", color: "#6aa9ff" };
    const engine: AsrEngine = {
      id: "local",
      modelId: "stub-model",
      run: async () => ({
        transcript: { speakers: [speaker], utterances: [{ start: 0, end: 2, speakerId: speaker.id, text: "你好" }] },
        chunks: [{ index: 1, start: 0, end: 2 }],
        timings: {},
        cacheHits: [],
        engine: "local",
        modelId: "stub-model",
      }),
    };
    const r = await runExtract({
      videoPath,
      notesRoot: join(dir, "notes"),
      endpoint,
      cacheRoot: join(dir, ".cache"),
      client: fakeClient(),
      asrEngine: engine,
      runToken: "tok-clean-ts",
    });
    expect(r.topicCount).toBe(1);
    expect(existsSync(join(r.video.outputDir, "video.json"))).toBe(true);
  });
});

/**
 * extract 无法注入 probe/ASR（`runExtract` 直接调 `probeVideo` 与 `createAsrEngine`），
 * 故用真 mp4 + 指向不存在模型目录的本地 ASR 触发失败：失败点在 `engine.run`（onPrepared 之后、
 * 写任何主题之前），可断言 token 写盘与 onPrepared 顺序。
 */
describe("runExtract 的 onPrepared 顺序与中断结算", () => {
  test("token 取锁后、写主题前落盘；onPrepared 在抽音前触发；失败结算后 token 清 null", async () => {
    const dir = mkdtemp();
    const videoPath = join(dir, "in.mp4");
    makeMp4(videoPath);
    const cacheRoot = join(dir, ".cache");

    const seen: Array<{ videoId: string; outputDir: string; runToken: string }> = [];
    let marker = "";
    const r = await
      runExtract({
        videoPath,
        notesRoot: join(dir, "notes"),
        endpoint,
        cacheRoot,
        client: fakeClient(),
        asr: { provider: "local", modelDir: join(dir, "no-such-model") },
        runToken: "tok-extract",
        onPrepared: async (info) => {
          seen.push(info);
          // 在 onPrepared 时刻读磁盘：token 已落盘、还没有任何主题
          marker = readFileSync(join(info.outputDir, "video.json"), "utf8");
        },
      })
    .catch((e) => e);
    // 失败（本地 ASR 模型缺失）
    expect(r).toBeInstanceOf(Error);
    expect(String((r as Error).message)).toContain("模型加载失败");

    // onPrepared 只触发一次，且带 token
    expect(seen).toHaveLength(1);
    expect(seen[0]?.runToken).toBe("tok-extract");
    expect(seen[0]?.videoId).not.toBe("");

    // onPrepared 时刻：token 已写盘、主题为空（写主题在抽音之后）
    const atPrepared = JSON.parse(marker) as { runToken: string | null; topics: unknown[] };
    expect(atPrepared.runToken).toBe("tok-extract");
    expect(atPrepared.topics).toEqual([]);

    // 封面抽帧在 onPrepared 之前已落盘（真实 ffmpeg 抽一帧）
    expect(existsSync(join(seen[0]!.outputDir, "cover.jpg"))).toBe(true);

    // 失败结算后：token 清 null，锁释放
    const final = JSON.parse(readFileSync(join(seen[0]!.outputDir, "video.json"), "utf8")) as { runToken: string | null };
    expect(final.runToken).toBeNull();
    expect(existsSync(join(seen[0]!.outputDir, ".vnote-run.lock"))).toBe(false);
  });
});

/**
 * 成功路径（r33 确认模型）：真 mp4 + 假 openai ASR（mock fetch）+ 假 LLM。
 * 断言导入划完主题即停——写 proposed、不生成笔记、不留 index.md/主题目录，封面已抽。
 */
describe("runExtract 成功路径：写 proposed 后停在笔记之前", () => {
  test("proposed 落盘、封面存在、不生成笔记与 index.md", async () => {
    const dir = mkdtemp();
    const videoPath = join(dir, "in.mp4");
    makeMp4(videoPath);
    const cacheRoot = join(dir, ".cache");

    const asrFetch = (async (_url: string) => {
      return new Response(JSON.stringify({ text: "你好", segments: [{ start: 0, end: 2, text: "你好" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const realFetch = globalThis.fetch;
    globalThis.fetch = asrFetch;
    try {
      const r = await runExtract({
        videoPath,
        notesRoot: join(dir, "notes"),
        endpoint,
        cacheRoot,
        client: fakeClient(),
        asr: { provider: "openai", baseUrl: "http://127.0.0.1:9", model: "whisper-1", apiKey: "test" },
        runToken: "tok-ok",
      });
      // 返回形状：主题已划、笔记未生成
      expect(r.topicCount).toBe(1);
      expect(r.noteCount).toBe(0);
      expect(r.notes).toEqual([]);
      expect(r.indexMarkdown).toBe("");

      const outputDir = r.video.outputDir;
      const data = JSON.parse(readFileSync(join(outputDir, "video.json"), "utf8")) as {
        runToken: string | null;
        topics: Array<Record<string, unknown>>;
      };
      // 导入后 token 保持（成功结算不清）
      expect(data.runToken).toBe("tok-ok");
      expect(data.topics).toHaveLength(1);
      const t = data.topics[0]!;
      expect(t.status).toBe("proposed");
      expect(t.selected).toBe(true);
      expect(t.clips).toEqual([]);
      expect(t.keyPoints).toEqual([]);
      // 封面抽帧成功
      expect(existsSync(join(outputDir, "cover.jpg"))).toBe(true);
      // 停在笔记之前：没有 index.md、没有主题目录
      expect(existsSync(join(outputDir, "index.md"))).toBe(false);
      expect(existsSync(join(outputDir, "foo"))).toBe(false);
      expect(existsSync(join(outputDir, ".vnote-run.lock"))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("timings 保留 ASR 引擎的分项真实值，不被一个总耗时覆写", async () => {
    const dir = mkdtemp();
    const videoPath = join(dir, "in.mp4");
    makeMp4(videoPath);
    const asrTimings = { readWave: 1.25, silence: 2.5, diarization: 3.75, asr: 4.5, total: 5.25 };
    const speaker = { id: "sp1" as SpeakerId, name: "说话人1", color: "#6aa9ff" };
    const engine: AsrEngine = {
      id: "local",
      modelId: "stub-model",
      run: async () => ({
        transcript: { speakers: [speaker], utterances: [{ start: 0, end: 2, speakerId: speaker.id, text: "你好" }] },
        chunks: [{ index: 1, start: 0, end: 2 }],
        timings: { ...asrTimings },
        cacheHits: [],
        engine: "local",
        modelId: "stub-model",
      }),
    };
    const r = await runExtract({
      videoPath,
      notesRoot: join(dir, "notes"),
      endpoint,
      cacheRoot: join(dir, ".cache"),
      client: fakeClient(),
      asrEngine: engine,
      runToken: "tok-timings",
    });
    for (const [key, value] of Object.entries(asrTimings)) {
      if (key === "total") continue; // extract 最后用自己的整条导入耗时覆盖 total
      expect(r.timings[key]).toBe(value);
    }
    expect(r.timings.total).not.toBe(asrTimings.total);
    // extract 追加的段仍在；total 是整条导入的耗时（覆盖 ASR 引擎的 total）
    expect(typeof r.timings.audio).toBe("number");
    expect(typeof r.timings.transcribe).toBe("number");
    expect(r.timings["segment-topics"]).toBeGreaterThanOrEqual(0);
    expect(r.timings.total).toBeGreaterThanOrEqual(0);
  });

  test("重导入：清掉工具自有的旧主题目录并删旧 index.md", async () => {
    const dir = mkdtemp();
    const videoPath = join(dir, "in.mp4");
    makeMp4(videoPath);
    const cacheRoot = join(dir, ".cache");
    const asrFetch = (async (_url: string) => {
      return new Response(JSON.stringify({ text: "你好", segments: [{ start: 0, end: 2, text: "你好" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const realFetch = globalThis.fetch;
    globalThis.fetch = asrFetch;
    try {
      // 第一次导入
      const first = await runExtract({
        videoPath,
        notesRoot: join(dir, "notes"),
        endpoint,
        cacheRoot,
        client: fakeClient(),
        asr: { provider: "openai", baseUrl: "http://127.0.0.1:9", model: "whisper-1", apiKey: "test" },
      });
      const outputDir = first.video.outputDir;
      // 模拟上一次生成留下的工具目录 + 旧 index
      const oldTopicDir = join(outputDir, "old-topic");
      mkdirSync(oldTopicDir, { recursive: true });
      writeFileSync(join(oldTopicDir, "topic.md"), "# old\n");
      writeFileSync(join(oldTopicDir, "01-00-00-00-00-00-02.mp4"), "");
      writeFileSync(join(outputDir, "index.md"), "# 旧 index\n");
      // 第二次导入（同一视频，输出目录复用）
      const second = await runExtract({
        videoPath,
        notesRoot: join(dir, "notes"),
        endpoint,
        cacheRoot,
        client: fakeClient(),
        asr: { provider: "openai", baseUrl: "http://127.0.0.1:9", model: "whisper-1", apiKey: "test" },
      });
      expect(second.video.outputDir).toBe(outputDir);
      // 工具自有的旧目录被清、旧 index 被删；新一轮只有 proposed 主题
      expect(existsSync(oldTopicDir)).toBe(false);
      expect(existsSync(join(outputDir, "index.md"))).toBe(false);
      const data = JSON.parse(readFileSync(join(outputDir, "video.json"), "utf8")) as { topics: Array<Record<string, unknown>> };
      expect(data.topics.every((t) => t.status === "proposed")).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
