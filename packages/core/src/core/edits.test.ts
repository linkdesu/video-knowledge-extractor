import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteTopicSegment,
  deleteUtterance,
  mergeTopics,
  renameSpeaker,
  recoverInterruptedRun,
  setTopicProgress,
  setTopicSelected,
  settleRunWhileLocked,
} from "./edits";
import { emptyVideoData, readVideoData, writeVideoData } from "./video-data";
import type { TopicRecord, VideoData } from "./video-data";
import { renderTopicMarkdown } from "./render";
import type { SpeakerId, TopicId, Video } from "./types";

function mkdtemp(): string {
  const dir = join(tmpdir(), "vnote-edits-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 写一个外部活 pid 的锁：编辑命令应据此拒绝（pid 1 恒存活且不是本进程，避免 pid 复用歧义）。 */
function holdLock(dir: string): void {
  // 用父进程 pid 模拟「别人持锁」：Windows 上 pid 1 不存在，会被当陈旧锁接管
  writeFileSync(join(dir, ".vnote-run.lock"), `${JSON.stringify({ pid: process.ppid, startedAt: Date.now(), token: "x" })}\n`);
}

/** 用本进程 pid 写 `.vnote-run.lock`：模拟流水线进程自己持锁。 */
function holdSelfLock(dir: string): void {
  writeFileSync(join(dir, ".vnote-run.lock"), `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: "test" })}\n`);
}

function topic(overrides: Partial<TopicRecord> = {}): TopicRecord {
  return {
    id: "topic-1" as TopicId,
    title: "主题A",
    summary: "摘要A",
    segments: [{ start: 10, end: 20 }],
    dirName: "topic-a",
    status: "done",
    selected: false,
    keyPoints: [],
    clips: [{ file: "01-00-00-12-00-00-18.mp4", start: 12, end: 18, segmentIndexes: [0], segmentOffsets: [] }],
    startedAt: null,
    elapsedSeconds: null,
    error: null,
    ...overrides,
  };
}

function makeFixture(): { dir: string; data: VideoData } {
  const dir = mkdtemp();
  const video: Video = {
    id: "vid-0001" as never,
    title: "测试视频",
    sourcePath: "/tmp/测试视频.mp4",
    durationSeconds: 300,
    outputDir: dir,
  };
  const data = emptyVideoData(video);
  data.transcript = {
    speakers: [
      { id: "sp1" as SpeakerId, name: "说话人1", color: "#f00" },
    ],
    utterances: [
      { start: 11, end: 13, speakerId: "sp1" as SpeakerId, text: "你好" },
      { start: 131, end: 135, speakerId: "sp1" as SpeakerId, text: "再见" },
    ],
  };
  data.topics = [
    topic({
      id: "topic-1" as TopicId,
      title: "前段",
      summary: "前段摘要",
      segments: [
        { start: 10, end: 20 },
        { start: 120, end: 130 },
      ],
      dirName: "topic-a",
      keyPoints: ["要点一"],
      clips: [{ file: "01-00-00-12-00-00-18.mp4", start: 12, end: 18, segmentIndexes: [0], segmentOffsets: [] }],
    }),
    topic({
      id: "topic-2" as TopicId,
      title: "后段",
      summary: "后段摘要",
      segments: [{ start: 130.3, end: 140 }],
      dirName: "topic-b",
      clips: [{ file: "01-00-02-10-00-02-20.mp4", start: 130, end: 140, segmentIndexes: [0], segmentOffsets: [] }],
    }),
  ];
  for (const t of data.topics) {
    mkdirSync(join(dir, t.dirName), { recursive: true });
    for (const c of t.clips) writeFileSync(join(dir, t.dirName, c.file), "");
    writeFileSync(
      join(dir, t.dirName, "topic.md"),
      renderTopicMarkdown(
        { id: t.id, title: t.title, summary: t.summary, segments: t.segments },
        data.transcript.utterances.filter((u) => t.segments.some((s) => u.end > s.start && u.start < s.end)),
        t.keyPoints,
        t.clips.map((c) => ({ topicId: t.id, segment: { start: c.start, end: c.end }, path: join(dir, t.dirName, c.file), segmentIndexes: c.segmentIndexes })),
        new Map(data.transcript.speakers.map((s) => [s.id, s.name])),
      ),
    );
  }
  writeVideoData(dir, data);
  return { dir, data };
}

function videoDir(): string {
  return mkdtemp();
}

function legacyData(dir: string, topics: TopicRecord[]): VideoData {
  const data = emptyVideoData({ id: "vid-0001" as never, title: "t", sourcePath: "s", durationSeconds: 1, outputDir: dir });
  data.topics = topics;
  writeVideoData(dir, data);
  return data;
}

describe("运行锁拒绝编辑", () => {
  test("锁存在时所有编辑命令抛「视频正在生成，完成后再编辑」", () => {
    const { dir } = makeFixture();
    holdLock(dir);
    expect(() => renameSpeaker(dir, "sp1", "X")).toThrow("视频正在生成，完成后再编辑");
    expect(() => deleteUtterance(dir, 0)).toThrow("视频正在生成，完成后再编辑");
    expect(() => deleteTopicSegment(dir, "topic-1", 0)).toThrow("视频正在生成，完成后再编辑");
    expect(() => mergeTopics(dir, ["topic-1", "topic-2"])).toThrow("视频正在生成，完成后再编辑");
    expect(() => setTopicSelected(dir, "topic-1", true)).toThrow("视频正在生成，完成后再编辑");
    expect(() => setTopicProgress(dir, "topic-1", { status: "generating" })).toThrow("视频正在生成，完成后再编辑");
  });

  test("本进程自己持锁：进度写入放行，结构编辑（删段、合并）仍拒绝", () => {
    const { dir } = makeFixture();
    holdSelfLock(dir);
    const prog = setTopicProgress(dir, "topic-1", { status: "generating", startedAt: "2026-10-22T00:00:00.000Z" });
    expect(prog.topics[0]!.status).toBe("generating");
    const sel = setTopicSelected(dir, "topic-1", true);
    expect(sel.topics[0]!.selected).toBe(true);
    expect(() => deleteTopicSegment(dir, "topic-1", 0)).toThrow("视频正在生成，完成后再编辑");
    expect(() => mergeTopics(dir, ["topic-1", "topic-2"])).toThrow("视频正在生成，完成后再编辑");
  });
});

describe("renameSpeaker", () => {
  test("改名后 topic.md 正文里的说话人名随之变化", () => {
    const { dir } = makeFixture();
    renameSpeaker(dir, "sp1", "张老师");
    const md = readFileSync(join(dir, "topic-a", "topic.md"), "utf8");
    expect(md).toContain("**张老师**: 你好");
    expect(md).not.toContain("说话人1");
  });
});

describe("deleteUtterance", () => {
  test("删掉字幕后，覆盖到它的 topic.md 不再含该句", () => {
    const { dir } = makeFixture();
    deleteUtterance(dir, 0);
    const mdA = readFileSync(join(dir, "topic-a", "topic.md"), "utf8");
    expect(mdA).not.toContain("你好");
    const mdB = readFileSync(join(dir, "topic-b", "topic.md"), "utf8");
    expect(mdB).toContain("再见");
  });
});

describe("deleteTopicSegment", () => {
  test("删掉整段不删切片文件，只重映射 segmentIndexes 并标记 needs-rerun", () => {
    const { dir } = makeFixture();
    const out = deleteTopicSegment(dir, "topic-1", 0);
    expect(out.topics[0]!.status).toBe("needs-rerun");
    expect(out.topics[0]!.segments).toEqual([{ start: 120, end: 130 }]);
    expect(existsSync(join(dir, "topic-a", "01-00-00-12-00-00-18.mp4"))).toBe(true);
    // 切片只覆盖被删段 → 丢弃；覆盖保留段 → 下标从 1 重映射为 0
    const dir2 = videoDir();
    const data = {
      ...emptyVideoData({ id: "vid-0001" as never, title: "t", sourcePath: "s", durationSeconds: 1, outputDir: dir2 }),
    };
    data.transcript = { speakers: [], utterances: [{ start: 1, end: 2, speakerId: "sp" as SpeakerId, text: "x" }] };
    data.topics = [topic({
      segments: [{ start: 10, end: 20 }, { start: 30, end: 40 }],
      clips: [
        { file: "a.mp4", start: 10, end: 20, segmentIndexes: [0], segmentOffsets: [] },
        { file: "b.mp4", start: 30, end: 40, segmentIndexes: [1], segmentOffsets: [] },
        { file: "c.mp4", start: 10, end: 40, segmentIndexes: [0, 1], segmentOffsets: [2, 14] },
      ],
    })];
    writeVideoData(dir2, data);
    const out2 = deleteTopicSegment(dir2, "topic-1", 0);
    const files = out2.topics[0]!.clips.map((c) => c.file).sort();
    expect(files).toEqual(["b.mp4", "c.mp4"]);
    expect(out2.topics[0]!.clips.find((c) => c.file === "b.mp4")!.segmentIndexes).toEqual([0]);
    expect(out2.topics[0]!.clips.find((c) => c.file === "c.mp4")!.segmentIndexes).toEqual([0]);
  });

  test("删段同步收窄 segmentOffsets（单文件 topic.mp4 切片）", () => {
    const dir = videoDir();
    const data = {
      ...emptyVideoData({ id: "vid-0001" as never, title: "t", sourcePath: "s", durationSeconds: 1, outputDir: dir }),
    };
    data.transcript = { speakers: [], utterances: [{ start: 1, end: 2, speakerId: "sp" as SpeakerId, text: "x" }] };
    data.topics = [
      topic({
        segments: [{ start: 10, end: 20 }, { start: 50, end: 60 }],
        clips: [{ file: "topic.mp4", start: 8, end: 60, segmentIndexes: [0, 1], segmentOffsets: [2, 14] }],
      }),
    ];
    writeVideoData(dir, data);
    const out = deleteTopicSegment(dir, "topic-1", 0);
    const c = out.topics[0]!.clips[0]!;
    expect(c.file).toBe("topic.mp4");
    expect(c.segmentIndexes).toEqual([0]);
    expect(c.segmentOffsets).toEqual([14]);
  });

  test("只剩一段时拒绝删除", () => {
    const dir = videoDir();
    const data = {
      ...emptyVideoData({ id: "vid-0001" as never, title: "t", sourcePath: "s", durationSeconds: 1, outputDir: dir }),
    };
    data.transcript.utterances.push({ start: 1, end: 2, speakerId: "sp" as SpeakerId, text: "x" });
    data.topics = [topic({ segments: [{ start: 1, end: 2 }] })];
    writeVideoData(dir, data);
    expect(() => deleteTopicSegment(dir, "topic-1", 0)).toThrow("至少保留一个时间段");
  });

  test("无字幕（迁移文档）拒绝删段", () => {
    const dir = videoDir();
    legacyData(dir, [topic({ segments: [{ start: 1, end: 2 }, { start: 3, end: 4 }] })]);
    expect(() => deleteTopicSegment(dir, "topic-1", 0)).toThrow("该视频需要重新转写后才能编辑结构");
  });
});

describe("mergeTopics", () => {
  test("两个主题：时间段并集、排序，gap < 0.5s 合并，标题按文档顺序连接，目录保留在磁盘", () => {
    const { dir } = makeFixture();
    const out = mergeTopics(dir, ["topic-1", "topic-2"]);
    expect(out.topics).toHaveLength(1);
    const t = out.topics[0]!;
    expect(t.id).toBe("topic-1" as TopicId);
    expect(t.dirName).toBe("topic-a");
    expect(t.title).toBe("前段 / 后段");
    expect(t.summary).toBe("合并后的主题，摘要需要重新生成");
    expect(t.status).toBe("needs-rerun");
    expect(t.keyPoints).toEqual([]);
    expect(t.clips).toEqual([]);
    expect(t.segments).toEqual([
      { start: 10, end: 20 },
      { start: 120, end: 140 },
    ]);
    expect(existsSync(join(dir, "topic-b"))).toBe(true);
    expect(existsSync(join(dir, "topic-b", "01-00-02-10-00-02-20.mp4"))).toBe(true);
  });

  test("传入顺序与文档顺序相反时，标题仍按文档顺序", () => {
    const { dir } = makeFixture();
    const out = mergeTopics(dir, ["topic-2", "topic-1"]);
    const t = out.topics[0]!;
    expect(t.id).toBe("topic-1" as TopicId);
    expect(t.dirName).toBe("topic-a");
    expect(t.title).toBe("前段 / 后段");
  });

  test("gap 恰好 0.5s 不合并，0.49s 合并", () => {
    const dir = videoDir();
    const data = {
      ...emptyVideoData({ id: "vid-0001" as never, title: "t", sourcePath: "s", durationSeconds: 1, outputDir: dir }),
    };
    data.transcript.utterances.push({ start: 1, end: 2, speakerId: "sp" as SpeakerId, text: "x" });
    data.topics = [
      topic({ id: "a" as TopicId, segments: [{ start: 0, end: 10 }, { start: 20, end: 30 }] }),
      topic({ id: "b" as TopicId, segments: [{ start: 10.5, end: 12 }, { start: 30.49, end: 35 }] }),
    ];
    writeVideoData(dir, data);
    const out = mergeTopics(dir, ["a", "b"]);
    expect(out.topics[0]!.segments).toEqual([
      { start: 0, end: 10 },
      { start: 10.5, end: 12 },
      { start: 20, end: 35 },
    ]);
  });

  test("少于 2 个主题拒绝", () => {
    const { dir } = makeFixture();
    expect(() => mergeTopics(dir, ["topic-1"])).toThrow("至少需要两个主题");
  });

  test("无字幕（迁移文档）拒绝合并", () => {
    const dir = videoDir();
    legacyData(dir, [
      topic({ id: "a" as TopicId }),
      topic({ id: "b" as TopicId, segments: [{ start: 1, end: 2 }] }),
    ]);
    expect(() => mergeTopics(dir, ["a", "b"])).toThrow("该视频需要重新转写后才能编辑结构");
  });
});

describe("setTopicSelected / setTopicProgress", () => {
  test("勾选与进度落盘，且不重写 topic.md", () => {
    const { dir } = makeFixture();
    const mdPath = join(dir, "topic-a", "topic.md");
    const beforeMtime = statSync(mdPath).mtimeMs;
    const sel = setTopicSelected(dir, "topic-1", true);
    expect(sel.topics[0]!.selected).toBe(true);
    const prog = setTopicProgress(dir, "topic-1", { status: "generating", startedAt: "2026-10-21T00:00:00.000Z" });
    expect(prog.topics[0]!.status).toBe("generating");
    expect(prog.topics[0]!.startedAt).toBe("2026-10-21T00:00:00.000Z");
    expect(statSync(mdPath).mtimeMs).toBe(beforeMtime);
  });

  test("进度补丁写入生成结果：keyPoints、clips、dirName", () => {
    const { dir } = makeFixture();
    const out = setTopicProgress(dir, "topic-1", {
      status: "done",
      elapsedSeconds: 12,
      keyPoints: ["要点X"],
      clips: [{ file: "x.mp4", start: 1, end: 2, segmentIndexes: [0], segmentOffsets: [0] }],
      dirName: "topic-a-renamed",
    });
    const t = out.topics[0]!;
    expect(t.status).toBe("done");
    expect(t.elapsedSeconds).toBe(12);
    expect(t.keyPoints).toEqual(["要点X"]);
    expect({ ...t.clips[0]! }).toEqual({ file: "x.mp4", start: 1, end: 2, segmentIndexes: [0], segmentOffsets: [0] } as { file: string; start: number; end: number; segmentIndexes: number[]; segmentOffsets: number[] });
    expect(t.dirName).toBe("topic-a-renamed");
  });
});

/** 写一个带 token 与三个状态主题的文档：generating（带 startedAt）、queued、done。 */
function settleFixture(): { dir: string; token: string } {
  const { dir, data } = makeFixture();
  data.topics = [
    topic({ id: "gen" as TopicId, status: "generating", startedAt: new Date(Date.now() - 7200_000).toISOString() }),
    topic({ id: "q" as TopicId, status: "queued" }),
    topic({ id: "done" as TopicId, status: "done", elapsedSeconds: 5 }),
  ];
  data.runToken = "tok-abc";
  writeVideoData(dir, data);
  return { dir, token: "tok-abc" };
}

describe("settleRunWhileLocked（锁内结算）", () => {
  test("持锁成功：不再次取锁，generating/queued → failed，elapsed 结算，token 清 null", () => {
    const { dir } = settleFixture();
    holdSelfLock(dir);
    expect(settleRunWhileLocked(dir, "tok-abc", "本次生成未完成")).toBe(true);
    // 没有重新取锁：本进程锁文件仍在
    expect(existsSync(join(dir, ".vnote-run.lock"))).toBe(true);
    const d = readVideoData(dir)!;
    const gen = d.topics.find((t) => t.id === "gen")!;
    expect(gen.status).toBe("failed");
    expect(gen.error).toBe("本次生成未完成");
    // 7200s 前开始：elapsed 结算（秒级容差）
    expect(gen.elapsedSeconds).toBeGreaterThanOrEqual(7190);
    expect(gen.elapsedSeconds).toBeLessThanOrEqual(7230);
    expect(d.topics.find((t) => t.id === "q")!.status).toBe("failed");
    expect(d.topics.find((t) => t.id === "done")!.status).toBe("done");
    expect(d.runToken).toBeNull();
  });

  test("queued 主题保留已有 elapsedSeconds（不覆盖）", () => {
    const { dir } = settleFixture();
    const d = readVideoData(dir)!;
    d.topics.find((t) => t.id === "q")!.elapsedSeconds = 3;
    writeVideoData(dir, d);
    expect(settleRunWhileLocked(dir, "tok-abc", "m")).toBe(true);
    expect(readVideoData(dir)!.topics.find((t) => t.id === "q")!.elapsedSeconds).toBe(3);
  });

  test("token 不匹配不写", () => {
    const { dir } = settleFixture();
    expect(settleRunWhileLocked(dir, "other-token", "m")).toBe(false);
    const d = readVideoData(dir)!;
    expect(d.runToken).toBe("tok-abc");
    expect(d.topics.find((t) => t.id === "gen")!.status).toBe("generating");
  });

  test("幂等：结算后重复调用不写（token 已清）", () => {
    const { dir } = settleFixture();
    expect(settleRunWhileLocked(dir, "tok-abc", "m")).toBe(true);
    const after = JSON.stringify(readVideoData(dir));
    expect(settleRunWhileLocked(dir, "tok-abc", "m")).toBe(false);
    expect(JSON.stringify(readVideoData(dir))).toBe(after);
  });

  test("空/相对目录不写", () => {
    expect(settleRunWhileLocked("", "tok-abc", "m")).toBe(false);
    expect(settleRunWhileLocked("relative/path", "tok-abc", "m")).toBe(false);
  });

  test("文档缺失不写", () => {
    const dir = mkdtemp();
    expect(settleRunWhileLocked(dir, "tok-abc", "m")).toBe(false);
  });
});

describe("recoverInterruptedRun（锁外恢复）", () => {
  test("外部活锁不写（也不取锁）", () => {
    const { dir } = settleFixture();
    holdLock(dir);
    expect(recoverInterruptedRun(dir, "tok-abc", "本次生成已取消")).toBe(false);
    const d = readVideoData(dir)!;
    expect(d.runToken).toBe("tok-abc");
    expect(d.topics.find((t) => t.id === "gen")!.status).toBe("generating");
  });

  test("取锁失败不写（本进程活锁）", () => {
    const { dir } = settleFixture();
    holdSelfLock(dir);
    expect(recoverInterruptedRun(dir, "tok-abc", "m")).toBe(false);
    expect(readVideoData(dir)!.runToken).toBe("tok-abc");
  });

  test("空/相对目录不写", () => {
    expect(recoverInterruptedRun("", "tok-abc", "m")).toBe(false);
    expect(recoverInterruptedRun("relative", "tok-abc", "m")).toBe(false);
  });

  test("无锁：取锁结算并释放（token 匹配写、不匹配不写）", () => {
    const { dir, token } = settleFixture();
    expect(recoverInterruptedRun(dir, token, "本次生成已取消")).toBe(true);
    expect(existsSync(join(dir, ".vnote-run.lock"))).toBe(false);
    const d = readVideoData(dir)!;
    expect(d.runToken).toBeNull();
    expect(d.topics.find((t) => t.id === "gen")!.status).toBe("failed");
    expect(d.topics.find((t) => t.id === "gen")!.error).toBe("本次生成已取消");
    const f2 = settleFixture();
    expect(recoverInterruptedRun(f2.dir, "nope", "m")).toBe(false);
    expect(readVideoData(f2.dir)!.runToken).toBe("tok-abc");
  });
});
