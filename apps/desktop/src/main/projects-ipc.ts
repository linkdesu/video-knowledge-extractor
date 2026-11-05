import { mkdirSync } from "node:fs";
import { IPC } from "../shared/ipc";
import type { CreateProjectInput, ProjectDetail, ProjectSettingsPatch } from "../shared/ipc";
import type { ProjectService } from "./projects";

/** `ipcMain.handle` 注册的项目通道（`projects:event` 是推送，不在其中）。 */
export type ProjectInvokeChannel =
  | typeof IPC.projectsList
  | typeof IPC.projectsGet
  | typeof IPC.projectsCreate
  | typeof IPC.projectsDelete
  | typeof IPC.projectsStartMonitor
  | typeof IPC.projectsStartOrganize
  | typeof IPC.projectsUpdateSettings
  | typeof IPC.projectsConfirmTopic
  | typeof IPC.projectsOpenClipsDir;

export type ProjectHandler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>;

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`缺少${label}`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`${label}必须是非空字符串数组`);
  }
  return value;
}

function requireCreateInput(value: unknown): CreateProjectInput {
  if (typeof value !== "object" || value === null) throw new Error("缺少项目参数");
  const { name, rootDir } = value as Record<string, unknown>;
  return { name: requireString(name, "项目名称"), rootDir: requireString(rootDir, "项目目录") };
}

function requireSettingsPatch(value: unknown): ProjectSettingsPatch {
  if (typeof value !== "object" || value === null) throw new Error("缺少设置参数");
  const { name, autoSlice, chunkMinutes } = value as Record<string, unknown>;
  const patch: ProjectSettingsPatch = {};
  if (name !== undefined) patch.name = requireString(name, "项目名称");
  if (autoSlice !== undefined) {
    if (typeof autoSlice !== "boolean") throw new Error("自动切片必须是布尔值");
    patch.autoSlice = autoSlice;
  }
  if (chunkMinutes !== undefined) {
    if (typeof chunkMinutes !== "number") throw new Error("分块时长必须是数字");
    patch.chunkMinutes = chunkMinutes;
  }
  return patch;
}

/**
 * 项目 IPC 处理器（#125）：只做参数校验与调用业务层，Electron 细节留给 `main/index.ts`。
 * 处理器表按通道名返回，测试可以逐个通道直接调用，不经过 Electron。
 */
export function projectIpcHandlers(
  service: ProjectService,
  openDirectory: (path: string) => Promise<void>,
  /** 加入整理前要先走现有导入（注册、规范化）；缺省直接交给业务层（测试与未接执行器时）。 */
  organizer?: (projectId: string, videoIds: string[]) => ProjectDetail | Promise<ProjectDetail>,
): Record<ProjectInvokeChannel, ProjectHandler> {
  return {
    [IPC.projectsList]: () => service.list(),
    [IPC.projectsGet]: (_event, projectId) => service.get(requireString(projectId, "项目 id")),
    [IPC.projectsCreate]: (_event, input) => service.create(requireCreateInput(input)),
    [IPC.projectsDelete]: (_event, projectId) => {
      service.remove(requireString(projectId, "项目 id"));
    },
    [IPC.projectsStartMonitor]: (_event, projectId, directory) =>
      service.startMonitor(requireString(projectId, "项目 id"), requireString(directory, "监控目录")),
    [IPC.projectsStartOrganize]: (_event, projectId, videoIds) => {
      const id = requireString(projectId, "项目 id");
      const ids = requireStringArray(videoIds, "视频 id");
      return organizer === undefined ? service.startOrganize(id, ids) : organizer(id, ids);
    },
    [IPC.projectsUpdateSettings]: (_event, projectId, patch) =>
      service.updateSettings(requireString(projectId, "项目 id"), requireSettingsPatch(patch)),
    [IPC.projectsConfirmTopic]: (_event, projectId, topicKeyValue, lineIds) =>
      service.confirmTopic(
        requireString(projectId, "项目 id"),
        requireString(topicKeyValue, "主题"),
        requireStringArray(lineIds, "字幕行 id"),
      ),
    [IPC.projectsOpenClipsDir]: async (_event, projectId) => {
      const dir = service.clipsDir(requireString(projectId, "项目 id"));
      // 还没有第一条切片时目录可能不存在；「打开切片目录」按需创建（#121 第 51 条）
      mkdirSync(dir, { recursive: true });
      await openDirectory(dir);
    },
  };
}
