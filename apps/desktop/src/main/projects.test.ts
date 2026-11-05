import { describe, expect, test } from "bun:test";
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
