import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LlmClient } from "../core/steps";
import { runNotes, runTopics } from "./notes-run";

const endpoint = { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "test-model" };

/**
 * 真实源 mp4（340 秒，覆盖测试里最远的段 [300,330]）：r33 后切片走临时 part +
 * concat 成 `topic.mp4`，cutClip 不再短路预置文件，必须真 ffmpeg 切。
 */
function makeMp4(path: string, seconds: number): void {
  execFileSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", `color=c=red:s=128x80:d=${seconds}`, "-f", "lavfi", "-i", `sine=d=${seconds}`, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path],
    { stdio: "pipe" },
  );
}

/** 在临时目录里建好 `video.json` + 真实源 `src.mp4`；`outputDir` 为笔记输出目录。 */
function makeVideo(outputDir: string, mutate: (d: Record<string, unknown>) => void): void {
  mkdirSync(outputDir, { recursive: true });
  const d: Record<string, unknown> = {
    version: 1,
    video: { id: "vid-1", title: "测试视频", sourcePath: join(outputDir, "src.mp4"), durationSeconds: 340, outputDir },
    transcript: { speakers: [], utterances: [] },
    chunks: [],
    topics: [],
    importedAt: "2026-01-01T00:00:00.000Z",
    sourceBytes: 1234,
    asrModel: "whisper-x",
    runToken: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  mutate(d);
  writeFileSync(join(outputDir, "video.json"), JSON.stringify(d));
  makeMp4(join(outputDir, "src.mp4"), 340);
}

function topicRecord(o: {
  id: string;
  title: string;
  summary?: string;
  segments: { start: number; end: number }[];
  dirName: string;
  status?: string;
  selected?: boolean;
  keyPoints?: string[];
  clips?: { file: string; start: number; end: number; segmentIndexes: number[] }[];
}): Record<string, unknown> {
  return {
    id: o.id,
    title: o.title,
    summary: o.summary ?? "",
    segments: o.segments,
    dirName: o.dirName,
    status: o.status ?? "done",
    selected: o.selected ?? true,
    keyPoints: o.keyPoints ?? [],
    clips: o.clips ?? [],
    startedAt: null,
    elapsedSeconds: null,
    error: null,
  };
}

describe("runNotes", () => {
  test("空 topicIds 拒绝", async () => {
    const out = join(tmpdir(), "rn-empty");
    makeVideo(out, (d) => {
      d.transcript = { speakers: [], utterances: [{ start: 0, end: 30, speakerId: "s1", text: "x" }] };
      d.topics = [topicRecord({ id: "t", title: "T", segments: [{ start: 0, end: 30 }], dirName: "t" })];
    });
    await expect(runNotes({ outputDir: out, topicIds: [], endpoint, cacheRoot: join(out, ".cache") })).rejects.toThrow("请先勾选要生成的主题");
  });

  test("done 主题被跳过（mtime 不变），其余生成 topic.mp4（带 segmentOffsets），index.md 保留全部主题", async () => {
    const out = join(tmpdir(), "rn-main");
    makeVideo(out, (d) => {
      d.transcript = {
        speakers: [{ id: "s1", name: "说话人1", color: "#000" }],
        utterances: [
          { start: 0, end: 30, speakerId: "s1", text: "A 内容" },
          { start: 300, end: 330, speakerId: "s1", text: "B 内容" },
        ],
      };
      d.chunks = [{ index: 0, start: 0, end: 30 }];
      d.topics = [
        topicRecord({ id: "topicA", title: "A", segments: [{ start: 0, end: 30 }], dirName: "a", status: "proposed" }),
        topicRecord({
          id: "topicB",
          title: "B",
          segments: [{ start: 300, end: 330 }],
          dirName: "b",
          status: "done",
          selected: false,
          keyPoints: ["要点B"],
          clips: [{ file: "01-00-04-57-00-05-30.mp4", start: 298, end: 330, segmentIndexes: [0] }],
        }),
      ];
    });
    // 预置已 done 的 B 的产物：topic.md + 旧编号切片（done 主题不进入生成，文件必须原样保留）
    const dirB = join(out, "b");
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirB, "topic.md"), "# B\n\n## 要点\n- 要点B\n\n## 正文\n\n");
    writeFileSync(join(dirB, "01-00-04-57-00-05-30.mp4"), "bclip");
    const bMdMtime = statSync(join(dirB, "topic.md")).mtimeMs;
    const bClipMtime = statSync(join(dirB, "01-00-04-57-00-05-30.mp4")).mtimeMs;

    const client: LlmClient = { model: endpoint.model, chat: async () => JSON.stringify({ keyPoints: ["要点A"] }) };
    const r = await runNotes({ outputDir: out, topicIds: ["topicA", "topicB"], endpoint, cacheRoot: join(out, ".cache"), client });
    // B 已 done → 被过滤，只生成 A
    expect(r.noteCount).toBe(1);

    const json = JSON.parse(readFileSync(join(out, "video.json"), "utf8")) as { topics: Array<Record<string, unknown>> };
    const a = json.topics.find((t) => t.id === "topicA") as Record<string, unknown>;
    const b = json.topics.find((t) => t.id === "topicB") as Record<string, unknown>;
    // A：done、单文件 topic.mp4、segmentOffsets 带前移（0 段钳到 0 → 偏移 0）
    expect(a.status).toBe("done");
    expect(a.error).toBeNull();
    const aClips = a.clips as Array<Record<string, unknown>>;
    expect(aClips.length).toBe(1);
    expect(aClips[0]?.file).toBe("topic.mp4");
    expect(aClips[0]?.start).toBe(0);
    expect(aClips[0]?.end).toBe(30);
    expect(aClips[0]?.segmentIndexes).toEqual([0]);
    expect(aClips[0]?.segmentOffsets).toEqual([0]);
    expect(a.keyPoints).toEqual(["要点A"]);
    expect(existsSync(join(out, "a", "topic.mp4"))).toBe(true);
    // B（done）：完全没被改写——切片、要点、状态保持原样，文件 mtime 不变
    const bClips = b.clips as Array<Record<string, unknown>>;
    expect(bClips.length).toBe(1);
    expect(bClips[0]?.file).toBe("01-00-04-57-00-05-30.mp4");
    expect(bClips[0]?.segmentIndexes).toEqual([0]);
    expect(b.keyPoints).toEqual(["要点B"]);
    expect(b.status).toBe("done");
    expect(statSync(join(dirB, "topic.md")).mtimeMs).toBe(bMdMtime);
    expect(statSync(join(dirB, "01-00-04-57-00-05-30.mp4")).mtimeMs).toBe(bClipMtime);
    // index.md 两个主题都在：新数据 topic.mp4、旧数据编号切片
    const index = readFileSync(join(out, "index.md"), "utf8");
    expect(index).toContain("[A](./a/topic.md)");
    expect(index).toContain("[B](./b/topic.md)");
    expect(index).toContain("[切片](./a/topic.mp4)");
    expect(index).toContain("[切片](./b/01-00-04-57-00-05-30.mp4)");

    // 再确认：两个主题都已 done → 不生成、不报错、B 的产物 mtime 仍不变
    const r2 = await runNotes({ outputDir: out, topicIds: ["topicA", "topicB"], endpoint, cacheRoot: join(out, ".cache"), client });
    expect(r2.noteCount).toBe(0);
    expect(statSync(join(dirB, "topic.md")).mtimeMs).toBe(bMdMtime);
  });

  test("导入后的 proposed 状态：全部未生成时生成；子集确认只动未 done 的主题", async () => {
    const out = join(tmpdir(), "rn-proposed-" + Date.now());
    makeVideo(out, (d) => {
      d.transcript = {
        speakers: [{ id: "s1", name: "说话人1", color: "#000" }],
        utterances: [
          { start: 10, end: 20, speakerId: "s1", text: "第一段" },
          { start: 50, end: 60, speakerId: "s1", text: "第二段" },
        ],
      };
      d.chunks = [{ index: 0, start: 0, end: 60 }];
      // 模拟 runExtract 落盘：proposed + 全选 + 空产物
      d.topics = [
        topicRecord({ id: "topicA", title: "A", segments: [{ start: 10, end: 20 }], dirName: "a", status: "proposed" }),
        topicRecord({ id: "topicB", title: "B", segments: [{ start: 50, end: 60 }], dirName: "b", status: "proposed" }),
      ];
    });
    const client: LlmClient = { model: endpoint.model, chat: async () => JSON.stringify({ keyPoints: ["要点"] }) };
    const r = await runNotes({ outputDir: out, topicIds: ["topicA", "topicB"], endpoint, cacheRoot: join(out, ".cache"), client });
    expect(r.noteCount).toBe(2);
    const json = JSON.parse(readFileSync(join(out, "video.json"), "utf8")) as { topics: Array<Record<string, unknown>> };
    for (const t of json.topics) {
      expect(t.status).toBe("done");
      const clips = t.clips as Array<Record<string, unknown>>;
      expect(clips.length).toBe(1);
      expect(clips[0]?.file).toBe("topic.mp4");
    }
    // 一个主题只有一个 topic.mp4
    expect(existsSync(join(out, "a", "topic.mp4"))).toBe(true);
    expect(existsSync(join(out, "b", "topic.mp4"))).toBe(true);
    expect(readFileSync(join(out, "index.md"), "utf8")).toContain("[切片](./a/topic.mp4)");
  });

  test("force: done 主题被重新生成（topic.mp4 与 topic.md 重写，状态 done，noteCount 1）", async () => {
    const out = join(tmpdir(), "rn-force-" + Date.now());
    makeVideo(out, (d) => {
      d.transcript = {
        speakers: [{ id: "s1", name: "说话人1", color: "#000" }],
        utterances: [{ start: 0, end: 30, speakerId: "s1", text: "A 内容" }],
      };
      d.topics = [
        topicRecord({
          id: "topicA",
          title: "A",
          segments: [{ start: 0, end: 30 }],
          dirName: "a",
          status: "done",
          keyPoints: ["旧要点"],
          clips: [{ file: "01-00-00-00-00-00-30.mp4", start: 0, end: 30, segmentIndexes: [0] }],
        }),
      ];
    });
    const dirA = join(out, "a");
    mkdirSync(dirA, { recursive: true });
    writeFileSync(join(dirA, "topic.md"), "# A\n\n## 要点\n- 旧要点\n\n## 正文\n\n");
    writeFileSync(join(dirA, "topic.mp4"), "oldclip");
    const mdMtime = statSync(join(dirA, "topic.md")).mtimeMs;
    const clipMtime = statSync(join(dirA, "topic.mp4")).mtimeMs;

    const client: LlmClient = { model: endpoint.model, chat: async () => JSON.stringify({ keyPoints: ["新要点"] }) };
    const r = await runNotes({ outputDir: out, topicIds: ["topicA"], endpoint, cacheRoot: join(out, ".cache"), client, force: true });
    expect(r.noteCount).toBe(1);

    const json = JSON.parse(readFileSync(join(out, "video.json"), "utf8")) as { topics: Array<Record<string, unknown>> };
    const a = json.topics.find((t) => t.id === "topicA") as Record<string, unknown>;
    expect(a.status).toBe("done");
    expect(a.error).toBeNull();
    expect(a.keyPoints).toEqual(["新要点"]);
    const aClips = a.clips as Array<Record<string, unknown>>;
    expect(aClips.length).toBe(1);
    expect(aClips[0]?.file).toBe("topic.mp4");
    // topic.md 与 topic.mp4 都被重写（mtime 前进）
    expect(statSync(join(dirA, "topic.md")).mtimeMs).toBeGreaterThan(mdMtime);
    expect(statSync(join(dirA, "topic.mp4")).mtimeMs).toBeGreaterThan(clipMtime);
    expect(readFileSync(join(dirA, "topic.md"), "utf8")).toContain("新要点");
  });

  test("done 主题不带 force：跳过，noteCount 0，产物原样", async () => {
    const out = join(tmpdir(), "rn-skip-" + Date.now());
    makeVideo(out, (d) => {
      d.transcript = {
        speakers: [{ id: "s1", name: "说话人1", color: "#000" }],
        utterances: [{ start: 0, end: 30, speakerId: "s1", text: "A 内容" }],
      };
      d.topics = [
        topicRecord({
          id: "topicA",
          title: "A",
          segments: [{ start: 0, end: 30 }],
          dirName: "a",
          status: "done",
          keyPoints: ["要点A"],
          clips: [{ file: "01-00-00-00-00-00-30.mp4", start: 0, end: 30, segmentIndexes: [0] }],
        }),
      ];
    });
    const dirA = join(out, "a");
    mkdirSync(dirA, { recursive: true });
    writeFileSync(join(dirA, "topic.md"), "# A\n\n## 要点\n- 要点A\n\n## 正文\n\n");
    writeFileSync(join(dirA, "topic.mp4"), "oldclip");
    const mdMtime = statSync(join(dirA, "topic.md")).mtimeMs;
    const clipMtime = statSync(join(dirA, "topic.mp4")).mtimeMs;

    const client: LlmClient = { model: endpoint.model, chat: async () => JSON.stringify({ keyPoints: ["新要点"] }) };
    const r = await runNotes({ outputDir: out, topicIds: ["topicA"], endpoint, cacheRoot: join(out, ".cache"), client });
    expect(r.noteCount).toBe(0);
    const json = JSON.parse(readFileSync(join(out, "video.json"), "utf8")) as { topics: Array<Record<string, unknown>> };
    const a = json.topics.find((t) => t.id === "topicA") as Record<string, unknown>;
    expect(a.status).toBe("done");
    expect(a.keyPoints).toEqual(["要点A"]);
    expect(statSync(join(dirA, "topic.md")).mtimeMs).toBe(mdMtime);
    expect(statSync(join(dirA, "topic.mp4")).mtimeMs).toBe(clipMtime);
    expect(readFileSync(join(dirA, "topic.md"), "utf8")).toBe("# A\n\n## 要点\n- 要点A\n\n## 正文\n\n");
  });

  test("成功生成后清 speakerChangedAt（force 重生成 done 主题）", async () => {
    const out = join(tmpdir(), "rn-speaker-" + Date.now());
    makeVideo(out, (d) => {
      d.speakerChangedAt = "2026-10-01T00:00:00.000Z";
      d.transcript = {
        speakers: [{ id: "s1", name: "说话人1", color: "#000" }],
        utterances: [{ start: 0, end: 30, speakerId: "s1", text: "A 内容" }],
      };
      d.topics = [
        topicRecord({
          id: "topicA",
          title: "A",
          segments: [{ start: 0, end: 30 }],
          dirName: "a",
          status: "done",
          keyPoints: ["旧要点"],
          clips: [{ file: "01-00-00-00-00-00-30.mp4", start: 0, end: 30, segmentIndexes: [0] }],
        }),
      ];
    });
    const client: LlmClient = { model: endpoint.model, chat: async () => JSON.stringify({ keyPoints: ["新要点"] }) };
    const r = await runNotes({ outputDir: out, topicIds: ["topicA"], endpoint, cacheRoot: join(out, ".cache"), client, force: true });
    expect(r.noteCount).toBe(1);
    const json = JSON.parse(readFileSync(join(out, "video.json"), "utf8")) as { speakerChangedAt: string | null };
    expect(json.speakerChangedAt).toBeNull();
  });
});

describe("runTopics", () => {
  test("从存盘分块重建主题，同名主题分到不同目录，拼接成 topic.mp4 并删旧编号切片", async () => {
    const out = join(tmpdir(), "rt-main");
    makeVideo(out, (d) => {
      d.transcript = {
        speakers: [{ id: "s1", name: "说话人1", color: "#000" }],
        utterances: [
          { start: 10, end: 20, speakerId: "s1", text: "第一段" },
          { start: 30, end: 40, speakerId: "s1", text: "第二段" },
        ],
      };
      // 单个覆盖全部分布的分块：假端点第一次调用出块候选，第二次调用出合并结果
      d.chunks = [{ index: 0, start: 0, end: 60 }];
      d.topics = [
        topicRecord({
          id: "topic-1",
          title: "foo",
          summary: "旧",
          segments: [{ start: 10, end: 20 }],
          dirName: "foo",
          selected: true,
        }),
        topicRecord({
          id: "topic-2",
          title: "foo",
          summary: "旧",
          segments: [{ start: 30, end: 40 }],
          dirName: "foo-2",
          selected: false,
        }),
      ];
    });
    // 预置一个旧编号切片：拼接成功后必须被删掉
    mkdirSync(join(out, "foo"), { recursive: true });
    writeFileSync(join(out, "foo", "01-00-00-07-00-00-20.mp4"), "legacy");

    let call = 0;
    const client: LlmClient = {
      model: endpoint.model,
      chat: async (_m, opts) => {
        if (!opts?.json) throw new Error("需要 json");
        call += 1;
        if (call === 1) {
          // 块候选
          return JSON.stringify({ topics: [{ title: "foo", summary: "s", segments: [{ start: 10, end: 40 }] }] });
        }
        // 合并：拆成两个同名、不同时间段的主题
        return JSON.stringify({
          topics: [
            { title: "foo", summary: "s1", segments: [{ start: 10, end: 20 }] },
            { title: "foo", summary: "s2", segments: [{ start: 30, end: 40 }] },
          ],
        });
      },
    };
    const r = await runTopics({ outputDir: out, endpoint, cacheRoot: join(out, ".cache"), client });
    expect(r.topicCount).toBe(2);
    expect(r.noteCount).toBe(2);

    const json = JSON.parse(readFileSync(join(out, "video.json"), "utf8")) as { topics: Array<Record<string, unknown>> };
    const foo = json.topics.filter((t) => t.title === "foo");
    expect(foo.length).toBe(2);
    const dirs = foo.map((t) => t.dirName).sort();
    // 同名主题分到不同目录
    expect(dirs).toEqual(["foo", "foo-2"]);
    for (const t of foo) {
      expect(t.status).toBe("done");
      const clips = t.clips as Array<Record<string, unknown>>;
      expect(clips.length).toBe(1);
      expect(clips[0]?.file).toBe("topic.mp4");
      expect(clips[0]?.segmentIndexes).toEqual([0]);
      expect(clips[0]?.segmentOffsets).toEqual([2]);
    }
    // 单文件切片落盘；旧编号切片被删
    expect(existsSync(join(out, "foo", "topic.mp4"))).toBe(true);
    expect(existsSync(join(out, "foo-2", "topic.mp4"))).toBe(true);
    expect(existsSync(join(out, "foo", "01-00-00-07-00-00-20.mp4"))).toBe(false);
    const index = readFileSync(join(out, "index.md"), "utf8");
    expect(index).toContain("[切片](./foo/topic.mp4)");
    expect(index).toContain("[切片](./foo-2/topic.mp4)");
  });
});

describe("中断结算（runToken 与锁内结算）", () => {
  test("runNotes 普通失败：done 主题保持 done，失败主题 failed+补写 elapsed，token 清 null，锁释放", async () => {
    const out = join(tmpdir(), "rn-fail-" + Date.now());
    makeVideo(out, (d) => {
      d.transcript = {
        speakers: [{ id: "s1", name: "说话人1", color: "#000" }],
        utterances: [
          { start: 0, end: 30, speakerId: "s1", text: "A 内容" },
          { start: 300, end: 330, speakerId: "s1", text: "B 内容" },
        ],
      };
      d.topics = [
        topicRecord({ id: "topicA", title: "A", segments: [{ start: 0, end: 30 }], dirName: "a", status: "done" }),
        topicRecord({ id: "topicB", title: "B", segments: [{ start: 300, end: 330 }], dirName: "b", status: "queued" }),
      ];
    });
    let call = 0;
    const client: LlmClient = {
      model: endpoint.model,
      chat: async () => {
        call += 1;
        throw new Error("LLM 爆炸");
      },
    };
    await expect(
      runNotes({ outputDir: out, topicIds: ["topicA", "topicB"], endpoint, cacheRoot: join(out, ".cache"), client, runToken: "tok-123" }),
    ).rejects.toThrow("LLM 爆炸");
    expect(call).toBe(1);

    const json = JSON.parse(readFileSync(join(out, "video.json"), "utf8")) as { runToken: string | null; topics: Array<Record<string, unknown>> };
    const a = json.topics.find((t) => t.id === "topicA") as Record<string, unknown>;
    const b = json.topics.find((t) => t.id === "topicB") as Record<string, unknown>;
    // done 的主题 A 被过滤，保持 done（结算只动 generating/queued）
    expect(a.status).toBe("done");
    expect(a.error).toBeNull();
    // 当前主题 B：generateAll 标 failed + 补写 elapsedSeconds
    expect(b.status).toBe("failed");
    expect(b.error).toBe("LLM 爆炸");
    expect(typeof b.elapsedSeconds).toBe("number");
    // token 清 null
    expect(json.runToken).toBeNull();
    // 锁释放
    expect(existsSync(join(out, ".vnote-run.lock"))).toBe(false);
  });

  test("runNotes 全部已 done：不生成不报错，token 不清（下一次运行覆盖）", async () => {
    const out = join(tmpdir(), "rn-ok-" + Date.now());
    makeVideo(out, (d) => {
      d.transcript = {
        speakers: [{ id: "s1", name: "说话人1", color: "#000" }],
        utterances: [{ start: 0, end: 30, speakerId: "s1", text: "A 内容" }],
      };
      d.topics = [topicRecord({ id: "topicA", title: "A", segments: [{ start: 0, end: 30 }], dirName: "a", status: "done" })];
    });
    let calls = 0;
    const client: LlmClient = { model: endpoint.model, chat: async () => (calls += 1, JSON.stringify({ keyPoints: ["要点A"] })) };
    const r = await runNotes({ outputDir: out, topicIds: ["topicA"], endpoint, cacheRoot: join(out, ".cache"), client, runToken: "tok-keep" });
    expect(r.noteCount).toBe(0);
    expect(calls).toBe(0);
    const json = JSON.parse(readFileSync(join(out, "video.json"), "utf8")) as { runToken: string | null };
    expect(json.runToken).toBe("tok-keep");
    expect(existsSync(join(out, ".vnote-run.lock"))).toBe(false);
  });

  test("runTopics 失败：划主题成功后逐主题生成失败，结算后磁盘终态", async () => {
    const out = join(tmpdir(), "rt-fail-" + Date.now());
    makeVideo(out, (d) => {
      d.transcript = {
        speakers: [{ id: "s1", name: "说话人1", color: "#000" }],
        utterances: [
          { start: 10, end: 20, speakerId: "s1", text: "第一段" },
          { start: 30, end: 40, speakerId: "s1", text: "第二段" },
        ],
      };
      d.chunks = [{ index: 0, start: 0, end: 60 }];
      d.topics = [];
    });

    let call = 0;
    const client: LlmClient = {
      model: endpoint.model,
      chat: async (_m, opts) => {
        if (!opts?.json) throw new Error("需要 json");
        call += 1;
        if (call === 1) return JSON.stringify({ topics: [{ title: "foo", summary: "s", segments: [{ start: 10, end: 40 }] }] });
        if (call === 2)
          return JSON.stringify({
            topics: [
              { title: "foo", summary: "s1", segments: [{ start: 10, end: 20 }] },
              { title: "foo", summary: "s2", segments: [{ start: 30, end: 40 }] },
            ],
          });
        throw new Error("笔记爆炸");
      },
    };
    await expect(runTopics({ outputDir: out, endpoint, cacheRoot: join(out, ".cache"), client, runToken: "tok-t" })).rejects.toThrow("笔记爆炸");

    const json = JSON.parse(readFileSync(join(out, "video.json"), "utf8")) as { runToken: string | null; topics: Array<Record<string, unknown>> };
    // 两个新主题：一个由 generateAll 标 failed（补写 elapsed），一个由流水线结算 failed
    expect(json.topics.filter((t) => t.status === "failed").length).toBe(2);
    expect(json.topics.every((t) => t.status === "failed")).toBe(true);
    expect(json.topics.map((t) => t.error).sort()).toEqual(["本次生成未完成", "笔记爆炸"]);
    // 补写 elapsedSeconds 的那个
    const withElapsed = json.topics.find((t) => t.error === "笔记爆炸") as Record<string, unknown>;
    expect(typeof withElapsed.elapsedSeconds).toBe("number");
    expect(json.runToken).toBeNull();
    expect(existsSync(join(out, ".vnote-run.lock"))).toBe(false);
  });
});
