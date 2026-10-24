import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteVideo, listLibrary, readLibraryVideo } from "./library";
import { emptyVideoData, readVideoData, writeVideoData } from "./video-data";
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
    expect(a.clips).toEqual([]);
    expect(a.status).toBe("needs-rerun");
    expect(a.error).toBe("切片文件缺失");
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
        clips: [{ file: "01-00-00-01-00-00-02.mp4", start: 1, end: 2, segmentIndexes: [0], segmentOffsets: [] }],
        startedAt: null,
        elapsedSeconds: null,
        error: null,
      },
    ];
    mkdirSync(join(outputDir, "文档主题"), { recursive: true });
    writeFileSync(join(outputDir, "文档主题", "topic.mp4"), "clip");
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

  test("已勾选主题全 done 且字幕非空 → done；未勾选主题 done 不拖状态", () => {
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
    for (const dirName of ["t1", "t2"]) {
      mkdirSync(join(outputDir, dirName), { recursive: true });
      writeFileSync(join(outputDir, dirName, "topic.mp4"), "clip");
    }
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

describe("resolution 透传与中断状态投影", () => {
  test("卡片透传文档的 resolution；无文档/旧目录为 null", () => {
    const { root, id } = fixture();
    const outputDir = join(root, "视频一");
    const data = emptyVideoData({ id: id as VideoId, title: "视频一", sourcePath: "/tmp/视频一.mp4", durationSeconds: 90, outputDir });
    data.transcript.utterances = [{ start: 1, end: 2, speakerId: "sp1" as SpeakerId, text: "你好" }];
    data.topics = [
      {
        id: "topic-1" as TopicId,
        title: "t",
        summary: "s",
        segments: [{ start: 1, end: 2 }],
        dirName: "t",
        status: "done",
        selected: false,
        keyPoints: [],
        clips: [],
        startedAt: null,
        elapsedSeconds: null,
        error: null,
      },
    ];
    data.resolution = { width: 1920, height: 886 };
    writeVideoData(outputDir, data);
    expect(listLibrary(root).find((v) => v.id === id)!.resolution).toEqual({ width: 1920, height: 886 });
    // 没有 video.json 的旧目录：resolution null
    expect(listLibrary(root).find((v) => v.id === "vid-missing")!.resolution).toBeNull();
  });

  test("无活锁时列表与详情一致：generating/queued 都按 failed 投影", () => {
    const { root, id } = fixture();
    const outputDir = join(root, "视频一");
    const data = emptyVideoData({ id: id as VideoId, title: "视频一", sourcePath: "/tmp/视频一.mp4", durationSeconds: 90, outputDir });
    data.transcript.utterances = [{ start: 1, end: 2, speakerId: "sp1" as SpeakerId, text: "你好" }];
    data.topics = [
      {
        id: "topic-1" as TopicId,
        title: "g",
        summary: "s",
        segments: [{ start: 1, end: 2 }],
        dirName: "g",
        status: "generating",
        selected: false,
        keyPoints: [],
        clips: [],
        startedAt: null,
        elapsedSeconds: null,
        error: null,
      },
      {
        id: "topic-2" as TopicId,
        title: "q",
        summary: "s",
        segments: [{ start: 3, end: 4 }],
        dirName: "q",
        status: "queued",
        selected: false,
        keyPoints: [],
        clips: [],
        startedAt: null,
        elapsedSeconds: null,
        error: null,
      },
    ];
    writeVideoData(outputDir, data);
    // 列表（videoSummary）
    const card = listLibrary(root).find((v) => v.id === id)!;
    expect(card.status).toBe("needs-rerun");
    // 详情（loadVideoData 投影）
    const detail = readLibraryVideo(root, id)!;
    expect(detail.data.topics.find((t) => t.id === "topic-1")!.status).toBe("failed");
    expect(detail.data.topics.find((t) => t.id === "topic-1")!.error).toBe("上次生成已中断");
    expect(detail.data.topics.find((t) => t.id === "topic-2")!.status).toBe("failed");
    expect(detail.video.status).toBe(card.status);
    // 磁盘未被回写：仍是 generating/queued
    const raw = JSON.parse(readFileSync(join(outputDir, "video.json"), "utf8")) as { topics: Array<Record<string, unknown>> };
    expect(raw.topics.map((t) => t.status).sort()).toEqual(["generating", "queued"]);
  });
});

describe("卡片状态与运行中的关系", () => {
  function videoWith(root: string, id: string, opts: { withTranscript: boolean; topicsDone: boolean }): string {
    const outputDir = join(root, "视频一");
    const data = emptyVideoData({ id: id as VideoId, title: "视频一", sourcePath: "/tmp/视频一.mp4", durationSeconds: 90, outputDir });
    if (opts.withTranscript) {
      data.transcript.utterances = [{ start: 1, end: 2, speakerId: "sp1" as SpeakerId, text: "你好" }];
    }
    data.topics = opts.topicsDone
      ? [
          {
            id: "t1" as TopicId,
            title: "t",
            summary: "s",
            segments: [{ start: 1, end: 2 }],
            dirName: "t",
            status: "done",
            selected: true,
            keyPoints: [],
            clips: [{ file: "01-00-00-01-00-00-02.mp4", start: 1, end: 2, segmentIndexes: [0], segmentOffsets: [] }],
            startedAt: null,
            elapsedSeconds: null,
            error: null,
          },
        ]
      : [];
    for (const t of data.topics) {
      if (t.status === "done") {
        mkdirSync(join(outputDir, t.dirName), { recursive: true });
        writeFileSync(join(outputDir, t.dirName, "topic.mp4"), "clip");
      }
    }
    writeVideoData(outputDir, data);
    return outputDir;
  }

  test("字幕已落盘、主题还没出来（无任务）：in-progress，不能因空 topics 判 done", () => {
    const { root, id } = fixture();
    videoWith(root, id, { withTranscript: true, topicsDone: false });
    expect(listLibrary(root).find((v) => v.id === id)!.status).toBe("in-progress");
  });

  test("字幕已落盘、主题为空且该视频正在跑任务：in-progress", () => {
    const { root, id } = fixture();
    videoWith(root, id, { withTranscript: true, topicsDone: false });
    expect(listLibrary(root, { busyVideoId: id }).find((v) => v.id === id)!.status).toBe("in-progress");
  });

  test("重跑排队中：文档仍是上一轮的 done，但 busyVideoId 命中 → in-progress", () => {
    const { root, id } = fixture();
    videoWith(root, id, { withTranscript: true, topicsDone: true });
    expect(listLibrary(root).find((v) => v.id === id)!.status).toBe("done");
    expect(listLibrary(root, { busyVideoId: id }).find((v) => v.id === id)!.status).toBe("in-progress");
  });

  test("别的视频在跑：本卡保持 done", () => {
    const { root, id } = fixture();
    videoWith(root, id, { withTranscript: true, topicsDone: true });
    expect(listLibrary(root, { busyVideoId: "vid-missing" }).find((v) => v.id === id)!.status).toBe("done");
  });
});

describe("done 主题缺切片的读侧投影（r35）", () => {
  function writeDoneVideo(root: string, id: string): string {
    const outputDir = join(root, "视频一");
    const data = emptyVideoData({ id: id as VideoId, title: "视频一", sourcePath: "/tmp/视频一.mp4", durationSeconds: 90, outputDir });
    data.transcript.utterances = [{ start: 1, end: 2, speakerId: "sp1" as SpeakerId, text: "你好" }];
    data.topics = [
      {
        id: "t1" as TopicId,
        title: "t",
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
    ];
    writeVideoData(outputDir, data);
    return outputDir;
  }

  test("video.json 说 done 但没有 topic.mp4：卡片与主题都报 needs-rerun；补上非空切片后翻回 done", () => {
    const { root, id } = fixture();
    const outputDir = writeDoneVideo(root, id);
    // 缺切片：卡片 needs-rerun（不再误报 done）
    expect(listLibrary(root).find((v) => v.id === id)!.status).toBe("needs-rerun");
    const detail = readLibraryVideo(root, id)!;
    expect(detail.data.topics[0]!.status).toBe("needs-rerun");
    expect(detail.data.topics[0]!.error).toBe("切片文件缺失");
    expect(detail.video.status).toBe("needs-rerun");
    // 落盘文档不被读侧改写：磁盘仍是 done
    const raw = JSON.parse(readFileSync(join(outputDir, "video.json"), "utf8")) as { topics: Array<Record<string, unknown>> };
    expect(raw.topics[0]!.status).toBe("done");
    // 补上非空 topic.mp4：卡片与主题都翻回 done
    mkdirSync(join(outputDir, "t1"), { recursive: true });
    writeFileSync(join(outputDir, "t1", "topic.mp4"), "clip");
    expect(listLibrary(root).find((v) => v.id === id)!.status).toBe("done");
    expect(readLibraryVideo(root, id)!.data.topics[0]!.status).toBe("done");
  });

  test("0 字节 topic.mp4 不算存在：仍 needs-rerun", () => {
    const { root, id } = fixture();
    const outputDir = writeDoneVideo(root, id);
    mkdirSync(join(outputDir, "t1"), { recursive: true });
    writeFileSync(join(outputDir, "t1", "topic.mp4"), "");
    expect(listLibrary(root).find((v) => v.id === id)!.status).toBe("needs-rerun");
  });
});

describe("卡片状态：proposed / pending-confirm / partial", () => {
  function writeCard(root: string, id: string, topics: Array<Record<string, unknown>>): void {
    const outputDir = join(root, "视频一");
    const data = emptyVideoData({ id: id as VideoId, title: "视频一", sourcePath: "/tmp/视频一.mp4", durationSeconds: 90, outputDir });
    data.transcript.utterances = [{ start: 1, end: 2, speakerId: "sp1" as SpeakerId, text: "你好" }];
    data.topics = topics as never;
    for (const t of data.topics) {
      if (t.status === "done") {
        mkdirSync(join(outputDir, t.dirName), { recursive: true });
        writeFileSync(join(outputDir, t.dirName, "topic.mp4"), "clip");
      }
    }
    writeVideoData(outputDir, data);
  }
  const topic = (id: string, status: string, selected = true): Record<string, unknown> => ({
    id,
    title: "t",
    summary: "s",
    segments: [{ start: 1, end: 2 }],
    dirName: id,
    status,
    selected,
    keyPoints: [],
    clips: [],
    startedAt: null,
    elapsedSeconds: null,
    error: null,
  });

  test("全部勾选主题 proposed → pending-confirm（failed 优先）", () => {
    const { root, id } = fixture();
    writeCard(root, id, [topic("t1", "proposed"), topic("t2", "proposed")]);
    expect(listLibrary(root).find((v) => v.id === id)!.status).toBe("pending-confirm");
    writeCard(root, id, [topic("t1", "failed"), topic("t2", "proposed")]);
    expect(listLibrary(root).find((v) => v.id === id)!.status).toBe("needs-rerun");
  });

  test("勾选主题 done 与 proposed 混合 → partial", () => {
    const { root, id } = fixture();
    writeCard(root, id, [topic("t1", "done"), topic("t2", "proposed")]);
    expect(listLibrary(root).find((v) => v.id === id)!.status).toBe("partial");
  });

  test("全 proposed 但都不勾选 → in-progress", () => {
    const { root, id } = fixture();
    writeCard(root, id, [topic("t1", "proposed", false), topic("t2", "proposed", false)]);
    expect(listLibrary(root).find((v) => v.id === id)!.status).toBe("in-progress");
  });
});

describe("deleteVideo", () => {
  function deleteFixture(): { root: string; cacheRoot: string; ids: [string, string]; source: string } {
    const root = mkdtemp();
    const cacheRoot = join(mkdtemp(), "cache");
    mkdirSync(cacheRoot, { recursive: true });
    const source = join(tmpdir(), "vnote-source-" + Date.now() + ".mp4");
    writeFileSync(source, "source-bytes");
    for (const [i, title] of [["vid-aaa1", "视频一"], ["vid-bbb2", "视频二"]] as const) {
      const dir = join(root, title);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.md"), "# 目录\n");
      const cache = join(cacheRoot, i);
      mkdirSync(cache, { recursive: true });
      writeFileSync(join(cache, "audio.bin"), "cache");
    }
    writeFileSync(
      join(root, "index.json"),
      JSON.stringify({
        videos: [
          { id: "vid-aaa1", title: "视频一", outputDir: "视频一", sourcePath: source },
          { id: "vid-bbb2", title: "视频二", outputDir: "视频二", sourcePath: source },
        ],
      }),
    );
    return { root, cacheRoot, ids: ["vid-aaa1", "vid-bbb2"], source };
  }

  test("删一个视频：输出目录、缓存目录、index 条目全删；另一个视频与源文件不动", () => {
    const { root, cacheRoot, ids, source } = deleteFixture();
    expect(deleteVideo(root, cacheRoot, ids[0])).toBe(true);
    expect(deleteVideo(root, cacheRoot, ids[0])).toBe(false);
    expect(listLibrary(root).map((v) => v.id as string)).toEqual([ids[1]]);
    expect(existsSync(join(root, "视频一"))).toBe(false);
    expect(existsSync(join(cacheRoot, ids[0]))).toBe(false);
    expect(existsSync(join(root, "视频二"))).toBe(true);
    expect(existsSync(join(cacheRoot, ids[1]))).toBe(true);
    expect(existsSync(source)).toBe(true);
    expect(readFileSync(source, "utf8")).toBe("source-bytes");
  });

  test("未知 id 返回 false 且什么都不改", () => {
    const { root, cacheRoot, ids, source } = deleteFixture();
    expect(deleteVideo(root, cacheRoot, "vid-9999")).toBe(false);
    expect(listLibrary(root).map((v) => v.id as string).sort()).toEqual(ids);
    expect(existsSync(join(root, "视频一"))).toBe(true);
    expect(existsSync(join(cacheRoot, ids[0]))).toBe(true);
    expect(existsSync(join(cacheRoot, ids[1]))).toBe(true);
    expect(existsSync(source)).toBe(true);
  });

  test("越界 outputDir 抛错且不删任何东西", () => {
    const root = mkdtemp();
    const cacheRoot = join(mkdtemp(), "cache");
    mkdirSync(cacheRoot, { recursive: true });
    const outside = mkdtemp();
    writeFileSync(join(outside, "keep.txt"), "keep");
    writeFileSync(
      join(root, "index.json"),
      JSON.stringify({ videos: [{ id: "vid-evil", title: "越界的", outputDir: "../evil" }] }),
    );
    expect(() => deleteVideo(root, cacheRoot, "vid-evil")).toThrow(/越出/);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "index.json"), "utf8")).videos).toHaveLength(1);
  });
});

describe("失败记录（r35）", () => {
  function doneCard(root: string, id: string): string {
    const outputDir = join(root, "视频一");
    for (const name of ["前段", "后段"]) rmSync(join(outputDir, name), { recursive: true, force: true });
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
    ];
    mkdirSync(join(outputDir, "t1"), { recursive: true });
    writeFileSync(join(outputDir, "t1", "topic.mp4"), "mp4");
    writeVideoData(outputDir, base);
    return outputDir;
  }

  test("失败记录 → 卡片 failed + 短原因；清掉后恢复原状态", () => {
    const { root, id } = fixture();
    const outputDir = doneCard(root, id);
    expect(listLibrary(root).find((v) => v.id === id)!.status).toBe("done");
    const written = writeVideoData(outputDir, { ...readVideoData(outputDir)!, failure: { message: "API key 无效", at: "2026-10-20T08:00:00.000Z" } });
    let v = listLibrary(root).find((x) => x.id === id)!;
    expect(v.status).toBe("failed");
    expect(v.failure).toBe("API key 无效");
    writeVideoData(outputDir, { ...written, failure: null });
    v = listLibrary(root).find((x) => x.id === id)!;
    expect(v.status).toBe("done");
    expect(v.failure).toBeNull();
  });

  test("失败记录优先于主题级 needs-rerun", () => {
    const { root, id } = fixture();
    const outputDir = doneCard(root, id);
    const base = readVideoData(outputDir)!;
    base.topics = base.topics.map((t) => (t.selected ? { ...t, status: "needs-rerun" as never, error: "boom" } : t));
    writeVideoData(outputDir, base);
    expect(listLibrary(root).find((v) => v.id === id)!.status).toBe("needs-rerun");
    writeVideoData(outputDir, { ...readVideoData(outputDir)!, failure: { message: "处理进程意外退出", at: "2026-10-20T09:00:00.000Z" } });
    const v = listLibrary(root).find((x) => x.id === id)!;
    expect(v.status).toBe("failed");
    expect(v.failure).toBe("处理进程意外退出");
  });
});
