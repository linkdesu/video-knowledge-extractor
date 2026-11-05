import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ClipProject,
  configureLogging,
  ProjectEventLog,
  ProjectStore,
  topicKey,
  type AnalysisJob,
  type ProjectExecutor,
  type SubtitleLine,
} from "@video-notes/core";
import { makeTmpDir } from "@video-notes/core/testing";
import type { ProjectDetail, ProjectEventPayload } from "../shared/ipc";
import { ProjectService } from "./projects";
import { encodeProjectClipUrl } from "./media";

const LINES: SubtitleLine[] = [
  { id: "l1", start: 0, end: 4, speaker: "主播", text: "开场" },
  { id: "l2", start: 4, end: 9, speaker: "主播", text: "第二个方法" },
  { id: "l3", start: 60, end: 66, speaker: "主播", text: "后面的内容" },
];

function setup() {
  const root = makeTmpDir("projects-service-");
  const store = ProjectStore.atRoot(root);
  const events = new ProjectEventLog();
  const service = new ProjectService({ store, events });
  const changes: ProjectEventPayload[] = [];
  service.onChange((payload) => changes.push(payload));
  return { root, service, changes };
}

function attachController(service: ProjectService, projectId: string, autoSlice = false) {
  const analyzed: AnalysisJob[] = [];
  const executor: ProjectExecutor = {
    analyze(job) {
      analyzed.push(job);
    },
    slice() {
      /* 切片执行由 #126 接入；这里只验证任务已入队 */
    },
  };
  const controller = new ClipProject({
    executor,
    transcriptOf: () => LINES,
    autoSlice,
  });
  controller.addFile({ id: "v1", name: "晚场直播.mp4", durationSeconds: 1200, growing: false, modifiedSeconds: 0 });
  service.attachRuntime(projectId, controller);
  return { controller, analyzed };
}

describe("项目服务：持久化与隔离", () => {
  test("创建后列表可读；两个项目设置互不影响；重启后仍在", () => {
    const { root, service } = setup();
    const a = service.create({ name: "项目 A", rootDir: join(root, "a") });
    const b = service.create({ name: "项目 B", rootDir: join(root, "b") });

    service.updateSettings(a.id, { autoSlice: false, chunkMinutes: 3 });
    service.startMonitor(a.id, join(root, "recordings"));
    service.startOrganize(a.id, ["v2", "v1"]);

    expect(service.list()).toMatchObject([
      { id: a.id, videoCount: 2, autoSlice: false, chunkMinutes: 3, monitoring: true, clipsDir: join(root, "a", "clips") },
      { id: b.id, videoCount: 0, autoSlice: true, chunkMinutes: 10, monitoring: false, clipsDir: join(root, "b", "clips") },
    ]);

    const reopened = new ProjectService({ store: ProjectStore.atRoot(root), events: new ProjectEventLog() });
    expect(reopened.get(b.id)).toMatchObject({ name: "项目 B", autoSlice: true, videoIds: [] });
    expect(reopened.get(a.id)).toMatchObject({
      autoSlice: false,
      chunkMinutes: 3,
      videoIds: ["v2", "v1"],
      watchDir: join(root, "recordings"),
      monitoring: true,
    });

    service.remove(a.id);
    expect(service.list().map((project) => project.id)).toEqual([b.id]);
  });

  test("设置修改写进运行日志（事件 + 结构化日志）", () => {
    const lines: string[] = [];
    configureLogging({ sink: (line) => lines.push(line) });
    try {
      const { root, service } = setup();
      const project = service.create({ name: "日志", rootDir: join(root, "p") });
      const updated = service.updateSettings(project.id, { chunkMinutes: 5, autoSlice: false });

      expect(updated.events[0]?.text).toBe("项目设置：5 分钟 / 自动切片关闭；已入队任务继续处理");
      expect(updated.events[0]?.level).toBe("info");
      expect(lines.some((line) => line.includes("project 项目设置：5 分钟 / 自动切片关闭"))).toBe(true);
      expect(lines.some((line) => line.includes(project.id))).toBe(true);
    } finally {
      configureLogging();
    }
  });

  test("已落盘的切片引用投影成产出卡片字段：标题、路径与播放地址（无视频库时有文件名标题）", () => {
    const { root, service } = setup();
    const project = service.create({ name: "产出", rootDir: join(root, "p") });
    const file = "001-为什么你的选题没人看？.mp4";
    ProjectStore.atRoot(root).recordClip(project.id, { seq: 1, videoId: "v1", topicId: "t1", file });

    expect(service.get(project.id).clips).toEqual([
      {
        seq: 1,
        videoId: "v1",
        topicId: "t1",
        file,
        title: "为什么你的选题没人看？",
        category: "",
        resolution: null,
        lineCount: 0,
        segmentCount: 0,
        durationSeconds: 0,
        segments: [],
        sourceName: null,
        path: join(root, "p", "clips", file),
        mediaUrl: encodeProjectClipUrl(project.id, file),
      },
    ]);
  });

  test("未知项目与非法设置报可读错误", () => {
    const { root, service } = setup();
    expect(() => service.get("missing")).toThrow("未知项目：missing");
    expect(() => service.create({ name: "", rootDir: join(root, "x") })).toThrow("项目名称不能为空");
    expect(() => service.startMonitor("missing", join(root, "w"))).toThrow("未知项目：missing");
    expect(() => service.confirmTopic("missing", "1:t1", ["l1"])).toThrow("未知项目：missing");
  });
});

describe("项目服务：队列与确认主题", () => {
  test("未接入执行器时队列为 null，设置与加入视频仍然持久化", () => {
    const { root, service } = setup();
    const project = service.create({ name: "未接入", rootDir: join(root, "p") });
    const detail = service.startOrganize(project.id, ["v1"]);
    expect(detail.queue).toBeNull();
    expect(detail.videoIds).toEqual(["v1"]);
    expect(detail.events[0]?.text).toBe("开始整理：1 个视频");
    expect(() => service.confirmTopic(project.id, "1:t1", ["l1"])).toThrow("项目执行器尚未接入");
  });

  test("接入控制器后：开始整理入分析队列，确认主题按行 id 入切片队列", () => {
    const { root, service, changes } = setup();
    const project = service.create({ name: "队列", rootDir: join(root, "p") });
    service.updateSettings(project.id, { autoSlice: false });
    const { controller } = attachController(service, project.id);

    const organized = service.startOrganize(project.id, ["v1"]);
    expect(organized.queue?.analysis.map((task) => task.status)).toEqual(["running", "waiting"]);
    expect(organized.queue?.files).toEqual([
      { id: "v1", name: "晚场直播.mp4", added: true, organizeStatus: "organizing", unslicedSeconds: 1200 },
    ]);

    controller.completeAnalysis(1, [
      { id: "t1", title: "为什么你的选题没人看？", category: "内容创作", lineIds: ["l1", "l2"] },
      { id: "t2", title: "把评论区变成选题库", category: "直播互动", lineIds: ["l3"] },
    ]);
    const proposed = service.get(project.id);
    expect(proposed.queue?.proposed.map((topic) => topic.title)).toEqual(["为什么你的选题没人看？", "把评论区变成选题库"]);
    expect(proposed.queue?.proposed[0]?.topicKey).toBe(topicKey(1, "t1"));

    const confirmed = service.confirmTopic(project.id, topicKey(1, "t1"), ["l2", "l1"]);
    expect(confirmed.queue?.slices).toMatchObject([
      { topicKey: "1:t1", title: "为什么你的选题没人看？", status: "running", lineCount: 2, segmentCount: 1, durationSeconds: 9 },
    ]);
    expect(confirmed.events[0]?.text).toBe("切片入队：为什么你的选题没人看？ · 2 行字幕");
    expect(confirmed.clips).toEqual([]);

    expect(() => service.confirmTopic(project.id, topicKey(1, "t1"), ["l1"])).toThrow("主题不存在或已确认");
    expect(() => service.confirmTopic(project.id, topicKey(1, "t2"), [])).toThrow("所选字幕为空");

    // 每次变化都推送一次全量详情
    const last = changes.at(-1);
    expect(last?.projectId).toBe(project.id);
    expect(last?.detail.queue?.slices).toHaveLength(1);
  });

  test("改设置会作用到已接入的控制器：分块时长只影响后续区间，打开自动切片提交待确认主题", () => {
    const { root, service } = setup();
    const project = service.create({ name: "设置", rootDir: join(root, "p") });
    service.updateSettings(project.id, { autoSlice: false });
    const { controller } = attachController(service, project.id);
    service.startOrganize(project.id, ["v1"]);
    controller.completeAnalysis(1, [{ id: "t1", title: "主题一", category: "分类", lineIds: ["l1"] }]);

    const before = service.updateSettings(project.id, { chunkMinutes: 2 });
    expect(before.chunkMinutes).toBe(2);
    expect(before.queue?.proposed).toHaveLength(1);

    const after = service.updateSettings(project.id, { autoSlice: true });
    expect(after.autoSlice).toBe(true);
    expect(after.queue?.proposed).toHaveLength(0);
    expect(after.queue?.slices.map((task) => task.topicKey)).toEqual(["1:t1"]);
    expect(after.events[0]?.text).toBe("项目设置：2 分钟 / 自动切片开启；已入队任务继续处理");
  });

  test("项目详情只含本项目的队列与事件", () => {
    const { root, service } = setup();
    const a = service.create({ name: "A", rootDir: join(root, "a") });
    const b = service.create({ name: "B", rootDir: join(root, "b") });
    attachController(service, a.id);
    service.startOrganize(a.id, ["v1"]);

    const detailA: ProjectDetail = service.get(a.id);
    const detailB: ProjectDetail = service.get(b.id);
    expect(detailA.queue?.analysis).toHaveLength(2);
    expect(detailB.queue).toBeNull();
    expect(detailB.events.map((event) => event.text)).toEqual(["创建项目：B"]);
    expect(detailA.events.map((event) => event.text)).toContain("开始整理：1 个视频");
  });
});

describe("项目服务：切片序号与记录（#126）", () => {
  test("确认主题支持含冒号的主题 id", () => {
    const { root, service } = setup();
    const project = service.create({ name: "冒号", rootDir: join(root, "p") });
    service.updateSettings(project.id, { autoSlice: false });
    const { controller } = attachController(service, project.id);
    service.startOrganize(project.id, ["v1"]);
    controller.completeAnalysis(1, [{ id: "topic:1", title: "带冒号", category: "", lineIds: ["l1"] }]);

    const detail = service.confirmTopic(project.id, topicKey(1, "topic:1"), ["l1"]);
    expect(detail.queue?.slices.map((task) => task.topicKey)).toEqual(["1:topic:1"]);
    expect(detail.events[0]?.text).toBe("切片入队：带冒号 · 1 行字幕");
  });

  test("recordClip 持久化切片引用与计数，重开项目后仍在", () => {
    const { root, service } = setup();
    const project = service.create({ name: "持久化", rootDir: join(root, "p") });
    const detail = service.recordClip(project.id, { seq: 7, videoId: "v1", topicId: "t1", file: "007-标题.mp4" });
    expect(detail.clipCount).toBe(1);
    // #130 起详情里的切片带展示字段（标题/路径/播放地址），引用四元组仍按契约原样保留
    expect(detail.clips).toMatchObject([{ seq: 7, videoId: "v1", topicId: "t1", file: "007-标题.mp4" }]);

    const reopened = new ProjectService({ store: ProjectStore.atRoot(root), events: new ProjectEventLog() });
    const again = reopened.get(project.id);
    expect(again.clipCount).toBe(1);
    expect(again.clips[0]?.file).toBe("007-标题.mp4");
    // 计数器已推进：下一个序号从 8 开始，不复用
    expect(reopened.beginClip(project.id, "复用检查").seq).toBe(8);
  });

  test("并行分配序号不碰撞：未落盘的序号也占位", () => {
    const { root, service } = setup();
    const project = service.create({ name: "并行", rootDir: join(root, "p") });
    const a = service.beginClip(project.id, "第一条");
    const b = service.beginClip(project.id, "第二条");
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(a.file).not.toBe(b.file);

    // 第一条落盘后第二条仍可用自己的序号落盘
    service.endClip(project.id, a.seq, { seq: a.seq, videoId: "v1", topicId: "t1", file: a.file });
    service.endClip(project.id, b.seq, { seq: b.seq, videoId: "v1", topicId: "t2", file: b.file });
    const detail = service.get(project.id);
    expect(detail.clips.map((clip) => clip.seq)).toEqual([1, 2]);
  });

  test("生成失败放弃序号：不写记录、计数器不前进、同序号可再用", () => {
    const { root, service } = setup();
    const project = service.create({ name: "失败", rootDir: join(root, "p") });
    const first = service.beginClip(project.id, "会失败");
    service.abortClip(project.id, first.seq);
    expect(service.get(project.id).clipCount).toBe(0);

    const again = service.beginClip(project.id, "会失败");
    expect(again.seq).toBe(first.seq);
    service.endClip(project.id, again.seq, { seq: again.seq, videoId: "v1", topicId: "t1", file: again.file });
    expect(service.get(project.id).clips[0]?.seq).toBe(first.seq);
  });

  test("projects.json 在数据根、视频库 index.json 在 notesRoot：两处路径互不影响", () => {
    const dataDir = makeTmpDir("projects-data-");
    const notes = makeTmpDir("projects-notes-");
    const store = ProjectStore.atRoot(dataDir);
    const service = new ProjectService({ store, events: new ProjectEventLog() });
    const project = service.create({ name: "分离", rootDir: join(dataDir, "root") });

    expect(existsSync(join(dataDir, "projects.json"))).toBe(true);
    expect(existsSync(join(notes, "projects.json"))).toBe(false);
    // 项目清单的读写完全不碰 notesRoot 的视频库索引
    expect(existsSync(join(notes, "index.json"))).toBe(false);
    expect(new ProjectService({ store: ProjectStore.atRoot(dataDir), events: new ProjectEventLog() }).get(project.id).name).toBe("分离");
  });
});
