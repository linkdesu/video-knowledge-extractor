import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_DIRNAME } from "./config";
import {
  VIDEO_DATA_VERSION,
  emptyVideoData,
  loadVideoData,
  migrateVideoData,
  readVideoData,
  writeVideoData,
  type VideoData,
} from "./video-data";
import type { SpeakerId, TopicId, Video, VideoId } from "./types";

function mkdtemp(): string {
  const dir = join(tmpdir(), "vnote-videodata-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeVideo(dir: string): Video {
  return {
    id: "vid-0001" as VideoId,
    title: "测试视频",
    sourcePath: "/tmp/测试视频.mp4",
    durationSeconds: 120,
    outputDir: dir,
  };
}

describe("video.json 文档", () => {
  test("写后读回往返一致，updatedAt 被盖上", () => {
    const dir = mkdtemp();
    const video = makeVideo(dir);
    const data: VideoData = {
      ...emptyVideoData(video),
      transcript: {
        speakers: [
          { id: "sp1" as SpeakerId, name: "说话人1", color: "#f00" },
        ],
        utterances: [{ start: 1, end: 2, speakerId: "sp1" as SpeakerId, text: "你好" }],
      },
      topics: [
        {
          id: "topic-1" as TopicId,
          title: "主题A",
          summary: "摘要",
          segments: [{ start: 10, end: 20 }],
          dirName: "topic-a",
          status: "generating",
          selected: true,
          keyPoints: ["要点一"],
          clips: [{ file: "01-00-00-07-00-00-20.mp4", start: 7, end: 20, segmentIndexes: [0] }],
          startedAt: "2026-10-20T00:00:00.000Z",
          elapsedSeconds: 5,
          error: "上次出错",
        },
      ],
      chunks: [{ index: 0, start: 0, end: 120 }],
      importedAt: "2026-10-20T00:00:00.000Z",
      sourceBytes: 12345,
      asrModel: "sherpa-onnx-test",
    };
    const written = writeVideoData(dir, data);
    expect(written.updatedAt).not.toBe(data.updatedAt);
    const read = readVideoData(dir);
    expect(read).toBeDefined();
    expect(read!.version).toBe(VIDEO_DATA_VERSION);
    expect(read!.video).toEqual(video);
    expect(read!.transcript.speakers[0]!.name).toBe("说话人1");
    expect(read!.topics[0]!.title).toBe("主题A");
    expect(read!.chunks).toEqual([{ index: 0, start: 0, end: 120 }]);
    expect(read!.importedAt).toBe("2026-10-20T00:00:00.000Z");
    expect(read!.sourceBytes).toBe(12345);
    expect(read!.asrModel).toBe("sherpa-onnx-test");
    expect(read!.topics[0]!.clips[0]!.segmentIndexes).toEqual([0]);
    expect(read!.updatedAt).toBe(written.updatedAt);
  });

  test("文件缺失返回 undefined", () => {
    const dir = mkdtemp();
    expect(readVideoData(dir)).toBeUndefined();
  });

  test("版本不符抛出指明文件与版本的错误", () => {
    const dir = mkdtemp();
    const video = makeVideo(dir);
    writeVideoData(dir, { ...emptyVideoData(video), version: 9 as 1 });
    expect(() => readVideoData(dir)).toThrow(/video\.json|version 应为 1/);
  });

  test("非数组 topics 被拒绝", () => {
    const dir = mkdtemp();
    const video = makeVideo(dir);
    writeVideoData(dir, { ...emptyVideoData(video), topics: "不是数组" } as unknown as VideoData);
    expect(() => readVideoData(dir)).toThrow(/不是数组/);
  });

  test("非字符串字段（title）被拒绝", () => {
    const dir = mkdtemp();
    const video = makeVideo(dir);
    const base = emptyVideoData(video);
    writeVideoData(dir, {
      ...base,
      topics: [
        {
          id: "t1",
          title: 42,
          summary: "s",
          segments: [],
          dirName: "d",
          status: "done",
          selected: false,
          keyPoints: [],
          clips: [],
          startedAt: null,
          elapsedSeconds: null,
          error: null,
        },
      ],
    } as unknown as VideoData);
    expect(() => readVideoData(dir)).toThrow(/不是字符串/);
  });

  test("损坏 JSON 被拒绝", () => {
    const dir = mkdtemp();
    writeFileSync(join(dir, "video.json"), "{ not json");
    expect(() => readVideoData(dir)).toThrow(/video\.json/);
  });
});

describe("状态归一", () => {
  test("generating 且没有存活 run.lock → failed + 上次生成已中断", () => {
    const dir = mkdtemp();
    const video = makeVideo(dir);
    const base = emptyVideoData(video);
    base.topics = [
      {
        id: "t1" as TopicId,
        title: "T",
        summary: "",
        segments: [{ start: 1, end: 2 }],
        dirName: "t1",
        status: "generating",
        selected: false,
        keyPoints: [],
        clips: [],
        startedAt: null,
        elapsedSeconds: null,
        error: null,
      },
    ];
    writeVideoData(dir, base);
    mkdirSync(join(dir, CACHE_DIRNAME), { recursive: true });
    writeFileSync(join(dir, CACHE_DIRNAME, "run.lock"), `${JSON.stringify({ pid: 2147483647, startedAt: Date.now() })}\n`);
    const loaded = loadVideoData(dir, { id: video.id, title: video.title, sourcePath: video.sourcePath });
    expect(loaded.topics[0]!.status).toBe("failed");
    expect(loaded.topics[0]!.error).toBe("上次生成已中断");
  });

  test("generating 且 run.lock 存活（本进程持锁）→ 保持 generating", () => {
    const dir = mkdtemp();
    const video = makeVideo(dir);
    const base = emptyVideoData(video);
    base.topics = [
      {
        id: "t1" as TopicId,
        title: "T",
        summary: "",
        segments: [{ start: 1, end: 2 }],
        dirName: "t1",
        status: "generating",
        selected: false,
        keyPoints: [],
        clips: [],
        startedAt: null,
        elapsedSeconds: null,
        error: null,
      },
    ];
    writeVideoData(dir, base);
    mkdirSync(join(dir, CACHE_DIRNAME), { recursive: true });
    writeFileSync(join(dir, CACHE_DIRNAME, "run.lock"), `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
    const loaded = loadVideoData(dir, { id: video.id, title: video.title, sourcePath: video.sourcePath });
    expect(loaded.topics[0]!.status).toBe("generating");
    expect(loaded.topics[0]!.error).toBeNull();
  });
});

describe("旧目录迁移", () => {
  test("从 topic.md 与切片文件名重建：标题、时间段、要点、切片、状态 done", () => {
    const dir = mkdtemp();
    const topicDir = join(dir, "主题-a");
    mkdirSync(topicDir, { recursive: true });
    writeFileSync(
      join(topicDir, "topic.md"),
      [
        "# 旧标题",
        "",
        "旧摘要",
        "",
        "## 要点",
        "- 要点一",
        "- 要点二",
        "",
        "## 正文",
        "",
        "### [00:00:10 - 00:00:20](01-00-00-07-00-00-20.mp4)",
        "**说话人1**: 你好",
        "",
        "### [00:02:00 - 00:02:30](02-00-02-00-00-02-30.mp4)",
        "**说话人1**: 再见",
        "",
      ].join("\n"),
    );
    writeFileSync(join(topicDir, "01-00-00-07-00-00-20.mp4"), "");
    writeFileSync(join(topicDir, "02-00-02-00-00-02-30.mp4"), "");
    writeFileSync(join(topicDir, "坏名字.mp4"), "");
    const video = makeVideo(dir);
    const migrated = migrateVideoData(dir, video);
    expect(migrated.topics).toHaveLength(1);
    const t = migrated.topics[0]!;
    expect(t.title).toBe("旧标题");
    expect(t.segments).toEqual([
      { start: 10, end: 20 },
      { start: 120, end: 150 },
    ]);
    expect(t.clips).toEqual([
      { file: "01-00-00-07-00-00-20.mp4", start: 7, end: 20, segmentIndexes: [0] },
      { file: "02-00-02-00-00-02-30.mp4", start: 120, end: 150, segmentIndexes: [1] },
    ]);
    expect(t.error).toBeNull();
    expect(t.status).toBe("done");
    expect(migrated.transcript.utterances).toEqual([]);
    expect(migrated.chunks).toEqual([]);
    expect(migrated.importedAt).toBeNull();
    expect(migrated.sourceBytes).toBeNull();
    expect(migrated.asrModel).toBeNull();
  });

  test("3 秒前移切片：切片起点早于段起点，segmentIndexes 仍按覆盖规则命中该段", () => {
    const dir = mkdtemp();
    const topicDir = join(dir, "主题-b");
    mkdirSync(topicDir, { recursive: true });
    writeFileSync(join(topicDir, "topic.md"), "# T\n\n### [00:00:10 - 00:00:20](01-00-00-07-00-00-20.mp4)\n");
    // 切片 7-20 覆盖段 10-20（start 7 <= 10 且 end 20 >= 20 - 0.4）
    writeFileSync(join(topicDir, "01-00-00-07-00-00-20.mp4"), "");
    // 切片 119-130：起点 119 晚于段起点 10，不覆盖段 10-20
    writeFileSync(join(topicDir, "02-00-01-59-00-02-10.mp4"), "");
    const migrated = migrateVideoData(dir, makeVideo(dir));
    const t = migrated.topics[0]!;
    expect(t.segments).toEqual([{ start: 10, end: 20 }]);
    expect(t.clips).toEqual([
      { file: "01-00-00-07-00-00-20.mp4", start: 7, end: 20, segmentIndexes: [0] },
      { file: "02-00-01-59-00-02-10.mp4", start: 119, end: 130, segmentIndexes: [] },
    ]);
    expect(t.error).toBeNull();
  });

  test("没有时间段标题：用切片范围近似 segments 并记 error", () => {
    const dir = mkdtemp();
    const topicDir = join(dir, "主题-c");
    mkdirSync(topicDir, { recursive: true });
    writeFileSync(join(topicDir, "topic.md"), "# T\n\n## 要点\n- 要点一\n");
    writeFileSync(join(topicDir, "01-00-00-07-00-00-20.mp4"), "");
    const migrated = migrateVideoData(dir, makeVideo(dir));
    const t = migrated.topics[0]!;
    expect(t.segments).toEqual([{ start: 7, end: 20 }]);
    expect(t.clips[0]!.segmentIndexes).toEqual([0]);
    expect(t.error).toBe("时间段按切片近似恢复");
    expect(t.keyPoints).toEqual(["要点一"]);
  });

  test("loadVideoData：没有 video.json 时走迁移且不回写", () => {
    const dir = mkdtemp();
    const topicDir = join(dir, "主题-a");
    mkdirSync(topicDir, { recursive: true });
    writeFileSync(join(topicDir, "topic.md"), "# 旧标题\n\n## 要点\n- 要点一\n\n## 正文\n\n### [00:00:10 - 00:00:20](01-00-00-07-00-00-20.mp4)\n");
    writeFileSync(join(topicDir, "01-00-00-07-00-00-20.mp4"), "");
    const video = makeVideo(dir);
    const loaded = loadVideoData(dir, { id: video.id, title: video.title, sourcePath: video.sourcePath });
    expect(loaded.topics).toHaveLength(1);
    expect(loaded.topics[0]!.title).toBe("旧标题");
    expect(existsSync(join(dir, "video.json"))).toBe(false);
  });
});
