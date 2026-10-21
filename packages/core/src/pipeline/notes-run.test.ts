import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LlmClient } from "../core/steps";
import { runNotes, runTopics } from "./notes-run";

const endpoint = { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "test-model" };

/** 在临时目录里建好 `video.json`；`outputDir` 为笔记输出目录。 */
function makeVideo(outputDir: string, mutate: (d: Record<string, unknown>) => void): void {
  mkdirSync(outputDir, { recursive: true });
  const d: Record<string, unknown> = {
    version: 1,
    video: { id: "vid-1", title: "测试视频", sourcePath: join(outputDir, "src.mp4"), durationSeconds: 40, outputDir },
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

  test("勾选主题生成带 segmentIndexes 的切片，未勾选主题不被改写，index.md 保留全部主题，子集重跑不删其他条目", async () => {
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
        topicRecord({ id: "topicA", title: "A", segments: [{ start: 0, end: 30 }], dirName: "a", status: "done" }),
        topicRecord({
          id: "topicB",
          title: "B",
          segments: [{ start: 300, end: 330 }],
          dirName: "b",
          status: "done",
          selected: false,
          keyPoints: ["要点B"],
          clips: [{ file: "01-00-04-57-00-05-30.mp4", start: 297, end: 330, segmentIndexes: [0] }],
        }),
      ];
    });
    // 预置两个主题的产物：topic.md + 切片文件（让 cutClip 短路，不依赖 ffmpeg）
    const dirA = join(out, "a");
    const dirB = join(out, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirA, "01-00-00-00-00-00-30.mp4"), "aclip");
    writeFileSync(join(dirB, "topic.md"), "# B\n\n## 要点\n- 要点B\n\n## 正文\n\n");
    writeFileSync(join(dirB, "01-00-04-57-00-05-30.mp4"), "bclip");

    const client: LlmClient = { model: endpoint.model, chat: async () => JSON.stringify({ keyPoints: ["要点A"] }) };
    const r = await runNotes({ outputDir: out, topicIds: ["topicA"], endpoint, cacheRoot: join(out, ".cache"), client });
    expect(r.noteCount).toBe(1);

    const json = JSON.parse(readFileSync(join(out, "video.json"), "utf8")) as { topics: Array<Record<string, unknown>> };
    const a = json.topics.find((t) => t.id === "topicA") as Record<string, unknown>;
    const b = json.topics.find((t) => t.id === "topicB") as Record<string, unknown>;
    // 勾选主题 A：done、clips 带 segmentIndexes、keyPoints 来自模型
    expect(a.status).toBe("done");
    expect(a.error).toBeNull();
    const aClips = a.clips as Array<Record<string, unknown>>;
    expect(aClips.length).toBe(1);
    expect(aClips[0]?.segmentIndexes).toEqual([0]);
    expect(aClips[0]?.file).toBe("01-00-00-00-00-00-30.mp4");
    expect(a.keyPoints).toEqual(["要点A"]);
    // 未勾选主题 B：完全没被改写（切片、要点、状态都保持原样）
    const bClips = b.clips as Array<Record<string, unknown>>;
    expect(bClips.length).toBe(1);
    expect(bClips[0]?.file).toBe("01-00-04-57-00-05-30.mp4");
    expect(bClips[0]?.segmentIndexes).toEqual([0]);
    expect(b.keyPoints).toEqual(["要点B"]);
    expect(b.status).toBe("done");
    // B 的 topic.md 标记未被覆盖
    expect(readFileSync(join(dirB, "topic.md"), "utf8")).toContain("要点B");
    // index.md 两个主题都在
    const index = readFileSync(join(out, "index.md"), "utf8");
    expect(index).toContain("[A](./a/topic.md)");
    expect(index).toContain("[B](./b/topic.md)");
    expect(index).toContain("[切片](./a/01-00-00-00-00-00-30.mp4)");
    expect(index).toContain("[切片](./b/01-00-04-57-00-05-30.mp4)");

    // 子集重跑：只选 topicB；topicA 的产物保持，topicB 更新
    const client2: LlmClient = { model: endpoint.model, chat: async () => JSON.stringify({ keyPoints: ["要点B2"] }) };
    const r2 = await runNotes({ outputDir: out, topicIds: ["topicB"], endpoint, cacheRoot: join(out, ".cache"), client: client2 });
    expect(r2.noteCount).toBe(1);
    const json2 = JSON.parse(readFileSync(join(out, "video.json"), "utf8")) as { topics: Array<Record<string, unknown>> };
    const a2 = json2.topics.find((t) => t.id === "topicA") as Record<string, unknown>;
    const b2 = json2.topics.find((t) => t.id === "topicB") as Record<string, unknown>;
    expect(a2.keyPoints).toEqual(["要点A"]);
    expect((a2.clips as Array<Record<string, unknown>>)[0]?.file).toBe("01-00-00-00-00-00-30.mp4");
    expect(b2.status).toBe("done");
    expect(b2.keyPoints).toEqual(["要点B2"]);
    const index2 = readFileSync(join(out, "index.md"), "utf8");
    // 子集重跑没有删掉 A 的条目
    expect(index2).toContain("[A](./a/topic.md)");
    expect(index2).toContain("[B](./b/topic.md)");
  });
});

describe("runTopics", () => {
  test("从存盘分块重建主题，同名主题分到不同目录", async () => {
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
    // 预置两个同名主题目录的切片（cutClip 短路，不依赖 ffmpeg）
    mkdirSync(join(out, "foo"), { recursive: true });
    writeFileSync(join(out, "foo", "01-00-00-07-00-00-20.mp4"), "c1");
    mkdirSync(join(out, "foo-2"), { recursive: true });
    writeFileSync(join(out, "foo-2", "01-00-00-27-00-00-40.mp4"), "c2");

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
    const sel = foo.map((t) => [t.dirName, t.selected] as [string, boolean]).sort((x, y) => (x[0] < y[0] ? -1 : 1));
    for (const t of foo) {
      expect(t.status).toBe("done");
      const clips = t.clips as Array<Record<string, unknown>>;
      expect(clips.length).toBe(1);
      expect(clips[0]?.segmentIndexes).toEqual([0]);
    }
    const index = readFileSync(join(out, "index.md"), "utf8");
    expect(index).toContain("[切片](./foo/01-00-00-07-00-00-20.mp4)");
    expect(index).toContain("[切片](./foo-2/01-00-00-27-00-00-40.mp4)");
  });
});

describe("中断结算（runToken 与锁内结算）", () => {
  test("runNotes 普通失败：完成主题保持 done，当前主题 failed+补写 elapsed，token 清 null，锁释放", async () => {
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
        topicRecord({ id: "topicB", title: "B", segments: [{ start: 300, end: 330 }], dirName: "b", status: "done" }),
      ];
    });
    // 预置主题 A 的切片文件（cutClip 短路，不依赖 ffmpeg）；B 在切前就失败
    mkdirSync(join(out, "a"), { recursive: true });
    writeFileSync(join(out, "a", "01-00-00-00-00-00-30.mp4"), "aclip");

    let call = 0;
    const client: LlmClient = {
      model: endpoint.model,
      chat: async () => {
        call += 1;
        if (call === 1) return JSON.stringify({ keyPoints: ["要点A"] });
        throw new Error("LLM 爆炸");
      },
    };
    await expect(
      runNotes({ outputDir: out, topicIds: ["topicA", "topicB"], endpoint, cacheRoot: join(out, ".cache"), client, runToken: "tok-123" }),
    ).rejects.toThrow("LLM 爆炸");

    const json = JSON.parse(readFileSync(join(out, "video.json"), "utf8")) as { runToken: string | null; topics: Array<Record<string, unknown>> };
    const a = json.topics.find((t) => t.id === "topicA") as Record<string, unknown>;
    const b = json.topics.find((t) => t.id === "topicB") as Record<string, unknown>;
    // 完成的主题 A 保持 done（结算只动 generating/queued）
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

  test("runNotes 成功：token 不清（下一次运行覆盖）", async () => {
    const out = join(tmpdir(), "rn-ok-" + Date.now());
    makeVideo(out, (d) => {
      d.transcript = {
        speakers: [{ id: "s1", name: "说话人1", color: "#000" }],
        utterances: [{ start: 0, end: 30, speakerId: "s1", text: "A 内容" }],
      };
      d.topics = [topicRecord({ id: "topicA", title: "A", segments: [{ start: 0, end: 30 }], dirName: "a", status: "done" })];
    });
    mkdirSync(join(out, "a"), { recursive: true });
    writeFileSync(join(out, "a", "01-00-00-00-00-00-30.mp4"), "aclip");
    const client: LlmClient = { model: endpoint.model, chat: async () => JSON.stringify({ keyPoints: ["要点A"] }) };
    await runNotes({ outputDir: out, topicIds: ["topicA"], endpoint, cacheRoot: join(out, ".cache"), client, runToken: "tok-keep" });
    const json = JSON.parse(readFileSync(join(out, "video.json"), "utf8")) as { runToken: string | null };
    expect(json.runToken).toBe("tok-keep");
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
    // 预置两个新主题的切片（cutClip 短路）
    mkdirSync(join(out, "foo"), { recursive: true });
    writeFileSync(join(out, "foo", "01-00-00-07-00-00-20.mp4"), "c1");
    mkdirSync(join(out, "foo-2"), { recursive: true });
    writeFileSync(join(out, "foo-2", "01-00-00-27-00-00-40.mp4"), "c2");

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
