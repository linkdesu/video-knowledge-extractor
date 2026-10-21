import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLibrary, readLibraryVideo } from "./library";
import { emptyVideoData, writeVideoData } from "./video-data";
import type { SpeakerId, TopicId, VideoId } from "./types";

function fixture(): { root: string; id: string } {
  const root = mkdtemp();
  const videoDir = join(root, "视频一");
  const topicA = join(videoDir, "前段");
  const topicB = join(videoDir, "后段");
  mkdirSync(topicA, { recursive: true });
  mkdirSync(topicB, { recursive: true });
  writeFileSync(join(topicA, "01-00-00-07-00-00-20.mp4"), "");
  writeFileSync(join(topicA, "坏名字.mp4"), "");
  writeFileSync(join(topicA, "topic.md"), "# 前段标题\n正文\n");
  writeFileSync(join(topicB, "topic.md"), "没有一级标题\n");
  writeFileSync(join(videoDir, "index.md"), "# 目录\n");
  writeFileSync(join(videoDir, "corrections.json"), JSON.stringify([{ wrong: "SKQ", right: "skill" }]));
  const id = "vid-1234";
  writeFileSync(
    join(root, "index.json"),
    JSON.stringify({
      videos: [
        { id, title: "视频一", outputDir: "视频一", sourcePath: "/tmp/视频一.mp4" },
        { id: "vid-missing", title: "丢了目录的", outputDir: "不存在" },
        { id: "vid-escape", title: "越界的", outputDir: "../evil" },
      ],
    }),
  );
  return { root, id };
}

function mkdtemp(): string {
  const dir = join(tmpdir(), "vnote-library-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("listLibrary", () => {
  test("列出全部条目；目录丢失的条目仍列出且计数为 0、状态 in-progress", () => {
    const { root } = fixture();
    const list = listLibrary(root);
    expect(list).toHaveLength(3);
    const missing = list.find((v) => v.id === "vid-missing");
    expect(missing).toBeDefined();
    expect(missing!.topicCount).toBe(0);
    expect(missing!.clipCount).toBe(0);
    expect(missing!.updatedAt).toBeNull();
    expect(missing!.status).toBe("in-progress");
  });

  test("没有 video.json 的旧目录：计数照常，有旧主题目录 → needs-rerun，时长未知为 null", () => {
    const { root } = fixture();
    const v = listLibrary(root).find((x) => x.id === "vid-1234")!;
    expect(v.topicCount).toBe(2);
    expect(v.clipCount).toBe(1);
    expect(typeof v.updatedAt).toBe("string");
    expect(v.status).toBe("needs-rerun");
    expect(v.durationSeconds).toBeNull();
  });

  test("无 index.json 时返回空列表", () => {
    const root = join(tmpdir(), "vnote-empty-" + Date.now());
    expect(listLibrary(root)).toEqual([]);
  });
});

describe("readLibraryVideo", () => {
  test("id 不在 index.json 返回 undefined", () => {
    const { root } = fixture();
    expect(readLibraryVideo(root, "nope")).toBeUndefined();
  });

  test("outputDir 越界（.. 逃逸）返回 undefined", () => {
    const { root } = fixture();
    expect(readLibraryVideo(root, "vid-escape")).toBeUndefined();
  });

  test("详情：video.json 文档（迁移口径的标题/切片）、词表、状态", () => {
    const { root, id } = fixture();
    const detail = readLibraryVideo(root, id)!;
    expect(detail.data.video.id).toBe(id as VideoId);
    expect(detail.data.topics).toHaveLength(2);
    const a = detail.data.topics.find((t) => t.dirName === "前段")!;
    expect(a.title).toBe("前段标题");
    expect(a.clips).toEqual([{ file: "01-00-00-07-00-00-20.mp4", start: 7, end: 20, segmentIndexes: [0] }]);
    expect(a.status).toBe("done");
    const b = detail.data.topics.find((t) => t.dirName === "后段")!;
    expect(b.title).toBe("后段");
    expect(b.clips).toEqual([]);
    expect(detail.corrections).toEqual([{ wrong: "SKQ", right: "skill" }]);
    expect(detail.video.status).toBe("needs-rerun");
    expect(detail.video.topicCount).toBe(2);
    expect(detail.video.clipCount).toBe(1);
  });

  test("有 video.json 时：计数、时长与状态来自文档", () => {
    const { root, id } = fixture();
    const outputDir = join(root, "视频一");
    const data = emptyVideoData({ id: id as VideoId, title: "视频一", sourcePath: "/tmp/视频一.mp4", durationSeconds: 90, outputDir });
    data.transcript.utterances = [{ start: 1, end: 2, speakerId: "sp1" as SpeakerId, text: "你好" }];
    data.topics = [
      {
        id: "topic-1" as TopicId,
        title: "文档主题",
        summary: "s",
        segments: [{ start: 1, end: 2 }],
        dirName: "文档主题",
        status: "done",
        selected: false,
        keyPoints: [],
        clips: [{ file: "01-00-00-01-00-00-02.mp4", start: 1, end: 2, segmentIndexes: [0] }],
        startedAt: null,
        elapsedSeconds: null,
        error: null,
      },
    ];
    writeVideoData(outputDir, data);
    const detail = readLibraryVideo(root, id)!;
    expect(detail.video.status).toBe("done");
    expect(detail.video.topicCount).toBe(1);
    expect(detail.video.clipCount).toBe(1);
    expect(detail.video.durationSeconds).toBe(90);
  });

  test("有 video.json 但主题 failed → needs-rerun", () => {
    const { root, id } = fixture();
    const outputDir = join(root, "视频一");
    const data = emptyVideoData({ id: id as VideoId, title: "视频一", sourcePath: "/tmp/视频一.mp4", durationSeconds: 90, outputDir });
    data.topics = [
      {
        id: "topic-1" as TopicId,
        title: "t",
        summary: "s",
        segments: [{ start: 1, end: 2 }],
        dirName: "t",
        status: "failed",
        selected: false,
        keyPoints: [],
        clips: [],
        startedAt: null,
        elapsedSeconds: null,
        error: "boom",
      },
    ];
    writeVideoData(outputDir, data);
    expect(listLibrary(root).find((v) => v.id === id)!.status).toBe("needs-rerun");
  });

  test("video.json 损坏：listLibrary 该卡 failed、计数 0、标题沿用 index.json，且不阻断其他条目", () => {
    const { root, id } = fixture();
    writeFileSync(join(root, "视频一", "video.json"), "{ not json");
    const list = listLibrary(root);
    const v = list.find((x) => x.id === id)!;
    expect(v.status).toBe("failed");
    expect(v.topicCount).toBe(0);
    expect(v.clipCount).toBe(0);
    expect(v.title).toBe("视频一");
    expect(v.durationSeconds).toBeNull();
    expect(list).toHaveLength(3);
  });

  test("video.json 损坏：readLibraryVideo 抛解析错误", () => {
    const { root, id } = fixture();
    writeFileSync(join(root, "视频一", "video.json"), "{ not json");
    expect(() => readLibraryVideo(root, id)).toThrow(/video\.json|不是合法 JSON/);
  });

  test("新文档（无主题、无字幕）：in-progress", () => {
    const { root, id } = fixture();
    const outputDir = join(root, "视频一");
    writeVideoData(outputDir, emptyVideoData({ id: id as VideoId, title: "视频一", sourcePath: "/tmp/视频一.mp4", durationSeconds: 90, outputDir }));
    expect(listLibrary(root).find((v) => v.id === id)!.status).toBe("in-progress");
  });

  test("已勾选主题全 done 且字幕非空 → done；未勾选主题 done 不拖状态（空勾选集视为 vacuous done）", () => {
    const { root, id } = fixture();
    const outputDir = join(root, "视频一");
    const base = emptyVideoData({ id: id as VideoId, title: "视频一", sourcePath: "/tmp/视频一.mp4", durationSeconds: 90, outputDir });
    base.transcript.utterances = [{ start: 1, end: 2, speakerId: "sp1" as SpeakerId, text: "你好" }];
    base.topics = [
      {
        id: "t1" as TopicId,
        title: "勾选",
        summary: "s",
        segments: [{ start: 1, end: 2 }],
        dirName: "t1",
        status: "done",
        selected: true,
        keyPoints: [],
        clips: [],
        startedAt: null,
        elapsedSeconds: null,
        error: null,
      },
      {
        id: "t2" as TopicId,
        title: "未勾选",
        summary: "s",
        segments: [{ start: 1, end: 2 }],
        dirName: "t2",
        status: "done",
        selected: false,
        keyPoints: [],
        clips: [],
        startedAt: null,
        elapsedSeconds: null,
        error: null,
      },
    ];
    writeVideoData(outputDir, base);
    expect(listLibrary(root).find((v) => v.id === id)!.status).toBe("done");
  });

  test("已勾选主题 failed → needs-rerun（即使字幕非空）", () => {
    const { root, id } = fixture();
    const outputDir = join(root, "视频一");
    const base = emptyVideoData({ id: id as VideoId, title: "视频一", sourcePath: "/tmp/视频一.mp4", durationSeconds: 90, outputDir });
    base.transcript.utterances = [{ start: 1, end: 2, speakerId: "sp1" as SpeakerId, text: "你好" }];
    base.topics = [
      {
        id: "t1" as TopicId,
        title: "勾选",
        summary: "s",
        segments: [{ start: 1, end: 2 }],
        dirName: "t1",
        status: "failed",
        selected: true,
        keyPoints: [],
        clips: [],
        startedAt: null,
        elapsedSeconds: null,
        error: "boom",
      },
    ];
    writeVideoData(outputDir, base);
    expect(listLibrary(root).find((v) => v.id === id)!.status).toBe("needs-rerun");
  });
});
