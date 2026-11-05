import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ClipProject, ProjectEventLog, ProjectStore, topicKey, type SubtitleLine } from "@video-notes/core";
import { makeTmpDir } from "@video-notes/core/testing";
import { IPC, type ProjectDetail, type ProjectSummary } from "../shared/ipc";
import { ProjectService } from "./projects";
import { projectIpcHandlers, type ProjectInvokeChannel } from "./projects-ipc";

const SRC = join(import.meta.dirname, "..");
const LINES: SubtitleLine[] = [
  { id: "l1", start: 0, end: 4, speaker: "主播", text: "开场" },
  { id: "l2", start: 4, end: 9, speaker: "主播", text: "第二个方法" },
];

const INVOKE_CHANNELS: ProjectInvokeChannel[] = [
  IPC.projectsList,
  IPC.projectsGet,
  IPC.projectsCreate,
  IPC.projectsDelete,
  IPC.projectsStartMonitor,
  IPC.projectsStartOrganize,
  IPC.projectsUpdateSettings,
  IPC.projectsConfirmTopic,
  IPC.projectsOpenClipsDir,
];

function harness() {
  const root = makeTmpDir("projects-ipc-");
  const service = new ProjectService({
    store: ProjectStore.atRoot(root),
    events: new ProjectEventLog(),
  });
  const opened: string[] = [];
  const handlers = projectIpcHandlers(service, async (dir) => {
    opened.push(dir);
  });
  return { root, service, handlers, opened };
}

describe("项目 IPC 契约", () => {
  test("每个项目通道都有处理器，通道名唯一且不含推送通道", () => {
    const { handlers } = harness();
    expect(Object.keys(handlers).sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(INVOKE_CHANNELS).not.toContain(IPC.projectsEvent as ProjectInvokeChannel);

    const projectChannels = Object.values(IPC).filter((channel) => channel.startsWith("projects:"));
    expect(projectChannels.filter((channel) => channel !== IPC.projectsEvent).sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(new Set(Object.values(IPC)).size).toBe(Object.values(IPC).length);

    // 主进程与 preload 必须都接上；少一个通道就是界面点了没反应的白屏
    const main = readFileSync(join(SRC, "main/index.ts"), "utf8");
    expect(main).toContain("projectIpcHandlers(projectService,");
    expect(main).toContain("ipcMain.handle(channel, guard(channel, handler))");
    const preload = readFileSync(join(SRC, "preload/index.ts"), "utf8");
    for (const channel of INVOKE_CHANNELS) {
      const key = Object.entries(IPC).find(([, value]) => value === channel)?.[0];
      expect(preload).toContain(`IPC.${key}`);
    }
    expect(preload).toContain("IPC.projectsEvent");
  });

  test("创建 → 列表 → 详情 → 设置 → 监控 → 整理 → 打开目录 → 删除", async () => {
    const { root, handlers, opened } = harness();
    const project = handlers[IPC.projectsCreate]!(null, { name: "晚场直播精华", rootDir: join(root, "项目") }) as ProjectDetail;
    expect(project.monitoring).toBe(false);
    expect(project.events.map((event) => event.text)).toEqual(["创建项目：晚场直播精华"]);

    const list = handlers[IPC.projectsList]!(null) as ProjectSummary[];
    expect(list).toMatchObject([{ id: project.id, name: "晚场直播精华", videoCount: 0, pendingTaskCount: 0, proposedTopicCount: 0, clipCount: 0 }]);

    const updated = handlers[IPC.projectsUpdateSettings]!(null, project.id, { chunkMinutes: 15, autoSlice: false }) as ProjectDetail;
    expect(updated).toMatchObject({ chunkMinutes: 15, autoSlice: false });
    expect(updated.events[0]?.text).toBe("项目设置：15 分钟 / 自动切片关闭；已入队任务继续处理");

    const monitored = handlers[IPC.projectsStartMonitor]!(null, project.id, join(root, "录屏")) as ProjectDetail;
    expect(monitored).toMatchObject({ monitoring: true, watchDir: join(root, "录屏") });
    expect(monitored.events[0]?.text).toBe(`监控已启动：${join(root, "录屏")}`);

    const organized = handlers[IPC.projectsStartOrganize]!(null, project.id, ["v1", "v1"]) as ProjectDetail;
    expect(organized.videoIds).toEqual(["v1"]);
    expect(organized.queue).toBeNull();
    expect(organized.events[0]?.text).toBe("开始整理：1 个视频");

    await handlers[IPC.projectsOpenClipsDir]!(null, project.id);
    expect(opened).toEqual([join(root, "项目", "clips")]);
    expect(existsSync(join(root, "项目", "clips"))).toBe(true);

    await handlers[IPC.projectsDelete]!(null, project.id);
    expect(handlers[IPC.projectsList]!(null)).toEqual([]);
    expect(() => handlers[IPC.projectsGet]!(null, project.id)).toThrow("未知项目");
  });

  test("确认主题只传行 id：处理器按当前字幕建切片任务", () => {
    const { root, service, handlers } = harness();
    const project = handlers[IPC.projectsCreate]!(null, { name: "确认", rootDir: join(root, "p") }) as ProjectDetail;
    handlers[IPC.projectsUpdateSettings]!(null, project.id, { autoSlice: false });

    const controller = new ClipProject({
      executor: { analyze() {}, slice() {} },
      transcriptOf: () => LINES,
      autoSlice: false,
    });
    controller.addFile({ id: "v1", name: "录制.mp4", durationSeconds: 600, growing: false, modifiedSeconds: 0 });
    service.attachRuntime(project.id, controller);
    handlers[IPC.projectsStartOrganize]!(null, project.id, ["v1"]);
    controller.completeAnalysis(1, [{ id: "t1", title: "主题一", category: "分类", lineIds: ["l1"] }]);

    const confirmed = handlers[IPC.projectsConfirmTopic]!(null, project.id, topicKey(1, "t1"), ["l2"]) as ProjectDetail;
    expect(confirmed.queue?.slices).toMatchObject([{ topicKey: "1:t1", lineCount: 1, segmentCount: 1, durationSeconds: 5 }]);
    expect(confirmed.events[0]?.text).toBe("切片入队：主题一 · 1 行字幕");
  });

  test("参数校验给出可读错误，不把坏参数送进业务层", () => {
    const { handlers } = harness();
    expect(() => handlers[IPC.projectsGet]!(null, "")).toThrow("缺少项目 id");
    expect(() => handlers[IPC.projectsCreate]!(null, { name: "x" })).toThrow("缺少项目目录");
    expect(() => handlers[IPC.projectsStartMonitor]!(null, "p1", "")).toThrow("缺少监控目录");
    expect(() => handlers[IPC.projectsStartOrganize]!(null, "p1", "v1")).toThrow("视频 id必须是非空字符串数组");
    expect(() => handlers[IPC.projectsUpdateSettings]!(null, "p1", { autoSlice: "yes" })).toThrow("自动切片必须是布尔值");
    expect(() => handlers[IPC.projectsUpdateSettings]!(null, "p1", { chunkMinutes: "10" })).toThrow("分块时长必须是数字");
    expect(() => handlers[IPC.projectsConfirmTopic]!(null, "p1", "1:t1", [])).toThrow("字幕行 id必须是非空字符串数组");
  });
});
