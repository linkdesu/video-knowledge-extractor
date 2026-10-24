import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LlmClient } from "../core/steps";
import { configureLogging } from "../core/logger";
import { notesTrigger, runNotes, runTopics } from "./notes-run";

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
function makeVideo(outputDir: string, mutate: (d: Record<string, unknown>) => void, seconds = 340): void {
  mkdirSync(outputDir, { recursive: true });
  const d: Record<string, unknown> = {
    version: 1,
    video: { id: "vid-1", title: "测试视频", sourcePath: join(outputDir, "src.mp4"), durationSeconds: seconds, outputDir },
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
  makeMp4(join(outputDir, "src.mp4"), seconds);
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
    const out = mkdtempSync(join(tmpdir(), "rn-empty-"));
    makeVideo(out, (d) => {
      d.transcript = { speakers: [], utterances: [{ start: 0, end: 30, speakerId: "s1", text: "x" }] };
      d.topics = [topicRecord({ id: "t", title: "T", segments: [{ start: 0, end: 30 }], dirName: "t" })];
    });
    await expect(runNotes({ outputDir: out, topicIds: [], endpoint, cacheRoot: join(out, ".cache") })).rejects.toThrow("请先勾选要生成的主题");
  });

  test("整批进度按 n/m 报：两个主题各生成一次，total 是本批主题数而不是 1", async () => {
    const out = mkdtempSync(join(tmpdir(), "rn-batch-progress-"));
    makeVideo(out, (d) => {
      d.transcript = {
        speakers: [{ id: "s1", name: "说话人1", color: "#000" }],
        utterances: [
          { start: 0, end: 30, speakerId: "s1", text: "A 内容" },
          { start: 60, end: 90, speakerId: "s1", text: "B 内容" },
        ],
      };
      d.topics = [
        topicRecord({ id: "topicA", title: "A", segments: [{ start: 0, end: 30 }], dirName: "a", status: "queued" }),
        topicRecord({ id: "topicB", title: "B", segments: [{ start: 60, end: 90 }], dirName: "b", status: "queued" }),
      ];
    }, 120);
    const client: LlmClient = { model: endpoint.model, chat: async () => JSON.stringify({ keyPoints: ["要点"] }) };
    const seen: Array<{ done: number; total: number; detail?: string }> = [];
    await runNotes({
      outputDir: out,
      topicIds: ["topicA", "topicB"],
      endpoint,
      cacheRoot: join(out, ".cache"),
      client,
      onProgress: (p) => {
        // topicPercent 0 是每个主题开始生成的那一次；切片子进度不再是 n/m 口径
        if (p.step === "generate-notes" && p.topicPercent === 0) {
          seen.push({ done: p.done, total: p.total, ...(p.detail !== undefined ? { detail: p.detail } : {}) });
        }
      },
    });
    expect(seen.map((p) => [p.detail, p.done, p.total])).toEqual([
      ["A", 0, 2],
      ["B", 1, 2],
    ]);
  }, 30000);

  test("done 主题被跳过（mtime 不变），其余生成 topic.mp4（带 segmentOffsets），index.md 保留全部主题", async () => {
    const out = mkdtempSync(join(tmpdir(), "rn-main-"));
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
    const bMdMtime = statSync(join(dirB, "topic.md")).mtimeMs;
    // 补上 topic.mp4：done 的产物齐全，投影后仍是 done，才谈得上「跳过」
    writeFileSync(join(dirB, "topic.mp4"), "bclip-mp4");
    writeFileSync(join(dirB, "01-00-04-57-00-05-30.mp4"), "legacy");
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

    // 再确认：两个主题都已 done 且产物齐全 → 待生成队列为空，明确报错
    await expect(
      runNotes({ outputDir: out, topicIds: ["topicA", "topicB"], endpoint, cacheRoot: join(out, ".cache"), client }),
    ).rejects.toThrow("本次没有需要生成的主题：所选主题均已生成完成");
  }, 30000);

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

  test("done 主题不带 force：产物齐全时队列为空，明确报错，产物原样", async () => {
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
    // 产物齐全的 done 主题：投影后仍是 done，队列为空 -> 明确报错，不再静默返回 0
    await expect(
      runNotes({ outputDir: out, topicIds: ["topicA"], endpoint, cacheRoot: join(out, ".cache"), client }),
    ).rejects.toThrow("本次没有需要生成的主题：所选主题均已生成完成");
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
      chat: async (messages, opts) => {
        if (!opts?.json) throw new Error("需要 json");
        // 要点请求按提示词识别：格式错误会被判为失败（r37），所以必须先于调用序判断
        if ((messages[0]?.content ?? "").startsWith("根据主题与字幕抽取")) {
          return JSON.stringify({ keyPoints: ["要点"] });
        }
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
    // A 的 done 产物齐全：投影后保持 done，才谈得上被过滤
    mkdirSync(join(out, "a"), { recursive: true });
    writeFileSync(join(out, "a", "topic.mp4"), "aclip");
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
    // 失败也追加轨迹记录
    const traj = JSON.parse(readFileSync(join(out, "b", "trajectory.json"), "utf8")) as { history: Array<Record<string, unknown>> };
    expect(traj.history.length).toBe(1);
    expect(traj.history[0]?.response).toEqual({ status: "failed", rawText: null, parsedSummary: null, error: "LLM 爆炸" });
    // 锁释放
    expect(existsSync(join(out, ".vnote-run.lock"))).toBe(false);
  });

  test("done 主题缺 topic.mp4（界面 needs-rerun）：被重新生成；产物齐全时拒绝「没有需要生成的主题」", async () => {
    const out = join(tmpdir(), "rn-rerun-" + Date.now());
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
          clips: [{ file: "topic.mp4", start: 0, end: 30, segmentIndexes: [0] }],
        }),
      ];
    });
    const dirA = join(out, "a");
    mkdirSync(dirA, { recursive: true });
    writeFileSync(join(dirA, "topic.md"), "# A\n\n## 要点\n- 旧要点\n\n## 正文\n\n");
    // topic.mp4 缺失：读侧投影为 needs-rerun，必须重新生成而不是静默返回 0
    const client: LlmClient = { model: endpoint.model, chat: async () => JSON.stringify({ keyPoints: ["新要点"] }) };
    const r = await runNotes({ outputDir: out, topicIds: ["topicA"], endpoint, cacheRoot: join(out, ".cache"), client });
    expect(r.noteCount).toBe(1);
    expect(existsSync(join(dirA, "topic.mp4"))).toBe(true);
    const json = JSON.parse(readFileSync(join(out, "video.json"), "utf8")) as { topics: Array<Record<string, unknown>> };
    const a = json.topics.find((t) => t.id === "topicA") as Record<string, unknown>;
    expect(a.status).toBe("done");
    expect(a.keyPoints).toEqual(["新要点"]);
    const traj = JSON.parse(readFileSync(join(dirA, "trajectory.json"), "utf8")) as { history: Array<Record<string, unknown>> };
    expect(traj.history.length).toBe(1);
    // 第二次运行：topic.mp4 已补齐 → 投影保持 done，队列为空，明确报错
    await expect(
      runNotes({ outputDir: out, topicIds: ["topicA"], endpoint, cacheRoot: join(out, ".cache"), client }),
    ).rejects.toThrow("本次没有需要生成的主题：所选主题均已生成完成");
    // 失败结算后锁释放
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

describe("术语表合并（全局 + 单视频）", () => {
  test("两份词表都进提示词与字幕替换，冲突项单视频优先，诊断日志记条数", async () => {
    const root = mkdtempSync(join(tmpdir(), "rn-glossary-"));
    const out = join(root, "vid-1");
    writeFileSync(
      join(root, "corrections.json"),
      JSON.stringify([
        { wrong: "zephyr", right: "Zephyr" },
        { wrong: "clash", right: "全局" },
      ]),
    );
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, "corrections.json"),
      JSON.stringify([
        { wrong: "clash", right: "本视频" },
        { wrong: "本地词", right: "本地正确" },
      ]),
    );
    makeVideo(out, (d) => {
      d.transcript = {
        speakers: [{ id: "s1", name: "说话人1", color: "#000" }],
        utterances: [{ start: 0, end: 30, speakerId: "s1", text: "zephyr clash 本地词" }],
      };
      d.topics = [
        topicRecord({ id: "topicA", title: "A", segments: [{ start: 0, end: 30 }], dirName: "a", status: "queued" }),
      ];
    });

    const lines: string[] = [];
    configureLogging({ level: "info", sink: (l) => lines.push(l) });
    const prompts: string[] = [];
    const client: LlmClient = {
      model: endpoint.model,
      chat: async (messages) => {
        prompts.push(messages.map((m) => m.content).join("\n"));
        return JSON.stringify({ keyPoints: ["要点"] });
      },
    };
    await runNotes({ outputDir: out, topicIds: ["topicA"], endpoint, cacheRoot: join(out, ".cache"), client });

    const prompt = prompts.join("\n");
    // 字幕已按合并结果替换：全局 zephyr → Zephyr，冲突项 clash 用本视频的写法
    expect(prompt).toContain("Zephyr 本视频 本地正确");
    // 提示词里的术语表包含三份生效词条，冲突的全局词条被丢弃
    expect(prompt).toContain("- zephyr → Zephyr");
    expect(prompt).toContain("- clash → 本视频");
    expect(prompt).toContain("- 本地词 → 本地正确");
    expect(prompt).not.toContain("clash → 全局");

    // 诊断日志：全局 2 条、单视频 2 条、合并生效 3 条
    const log = lines.find((l) => l.includes("术语表合并") && l.includes("stage=\"notes\"")) ?? "";
    expect(log).toContain("global=2");
    expect(log).toContain("video=2");
    expect(log).toContain("merged=3");
  });
});

describe("runTopics 术语表接线", () => {
  test("划主题提示词与字幕用合并词表，单视频优先，日志记 topics 条数", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-glossary-"));
    const out = join(root, "vid-1");
    writeFileSync(
      join(root, "corrections.json"),
      JSON.stringify([
        { wrong: "zephyr", right: "Zephyr" },
        { wrong: "clash", right: "全局" },
      ]),
    );
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "corrections.json"), JSON.stringify([{ wrong: "clash", right: "本视频" }]));
    makeVideo(out, (d) => {
      d.transcript = {
        speakers: [{ id: "s1", name: "说话人1", color: "#000" }],
        utterances: [{ start: 0, end: 30, speakerId: "s1", text: "zephyr clash" }],
      };
      d.chunks = [{ index: 0, start: 0, end: 30 }];
      d.topics = [];
    });

    const lines: string[] = [];
    configureLogging({ level: "info", sink: (l) => lines.push(l) });
    const systems: string[] = [];
    const users: string[] = [];
    const client: LlmClient = {
      model: endpoint.model,
      chat: async (messages) => {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        systems.push(system);
        users.push(user);
        if (user.startsWith("该块范围")) {
          return JSON.stringify({ topics: [{ title: "A", summary: "s", segments: [{ start: 0, end: 30 }] }] });
        }
        if (user.startsWith("视频共")) {
          return JSON.stringify({ topics: [{ title: "A", summary: "s", segments: [{ start: 0, end: 30 }] }] });
        }
        return JSON.stringify({ keyPoints: ["要点"] });
      },
    };
    await runTopics({ outputDir: out, endpoint, cacheRoot: join(out, ".cache"), client });

    // 分块提示词带合并术语表，冲突项用本视频写法
    expect(systems[0]).toContain("- zephyr → Zephyr");
    expect(systems[0]).toContain("- clash → 本视频");
    expect(systems[0]).not.toContain("clash → 全局");
    // 字幕已替换，分块与合并提示词都用替换后的文本
    expect(users[0]).toContain("Zephyr 本视频");
    expect(users[0]).not.toContain("zephyr clash");

    const log = lines.find((l) => l.includes("术语表合并") && l.includes("stage=\"topics\"")) ?? "";
    expect(log).toContain("global=2");
    expect(log).toContain("video=1");
    expect(log).toContain("merged=2");
  });
});


describe("notesTrigger", () => {
  test("force 优先；其次说话人变更标记；否则首次", () => {
    expect(notesTrigger({ speakerChangedAt: null }, undefined)).toBe("initial");
    expect(notesTrigger({ speakerChangedAt: null }, true)).toBe("regenerate");
    expect(notesTrigger({ speakerChangedAt: "2026-10-01T00:00:00.000Z" }, undefined)).toBe("speaker-changed");
    expect(notesTrigger({ speakerChangedAt: "2026-10-01T00:00:00.000Z" }, true)).toBe("regenerate");
  });
});