import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { writeJsonAtomic } from "./paths";

/**
 * 项目清单（#121 实现决策 1、#125）：数据根下一个 `projects.json` 记录全部整理切片项目，
 * 整文件原子写（ADR-0002）。切片的权威记录仍在 `video.json` 的主题 `clips` 里（ADR-0056 §7）；
 * 本文件的 `clips` 只保存按项目排序的轻量引用与序号计数器，供项目页统计与产出排序。
 */
export const PROJECTS_FILE_NAME = "projects.json";
export const PROJECTS_VERSION = 1;
export const PROJECT_NAME_MAX = 60;
export const PROJECT_CHUNK_MINUTES_DEFAULT = 10;
export const PROJECT_CHUNK_MINUTES_MIN = 1;
export const PROJECT_CHUNK_MINUTES_MAX = 30;

/** 项目清单里的切片引用：序号 + 定位 `video.json` 主题切片记录的键；不含切片内容。 */
export type ProjectClipRef = {
  seq: number;
  videoId: string;
  topicId: string;
  /** `clips/` 内的文件名（ADR-0056 §2）。 */
  file: string;
};

export type ProjectRecord = {
  id: string;
  name: string;
  /** 项目目录；切片固定在 `<项目目录>/clips`。 */
  rootDir: string;
  /** 监控目录；尚未监控为 null。 */
  watchDir: string | null;
  monitoring: boolean;
  chunkMinutes: number;
  autoSlice: boolean;
  /** 智能语义分块（#155）：停止增长后剩余区间整段入队；旧清单缺字段按开启。 */
  semanticChunking: boolean;
  /** 已加入整理、按加入顺序排列的视频 id；取消勾选不撤销。 */
  videoIds: string[];
  clips: ProjectClipRef[];
  /** 下一个项目切片序号；只增不减、失败不消耗（ADR-0056 §3）。 */
  nextClipSeq: number;
  createdAt: string;
  updatedAt: string;
};

export type ProjectsFile = { version: 1; projects: ProjectRecord[] };

export type CreateProjectInput = { name: string; rootDir: string; now?: Date; id?: string };

export type ProjectSettingsPatch = { name?: string; autoSlice?: boolean; chunkMinutes?: number; semanticChunking?: boolean };

export function projectsFilePath(root: string): string {
  return join(root, PROJECTS_FILE_NAME);
}

export function projectClipsDir(project: ProjectRecord): string {
  return join(project.rootDir, "clips");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanName(name: unknown): string {
  const text = typeof name === "string" ? name.trim() : "";
  if (text === "") throw new Error("项目名称不能为空");
  // 与原型 maxlength=60 同口径：按码点计数，不把代理对拆成两个
  if (Array.from(text).length > PROJECT_NAME_MAX) throw new Error(`项目名称不能超过 ${PROJECT_NAME_MAX} 个字`);
  return text;
}

function cleanRootDir(rootDir: unknown): string {
  if (typeof rootDir !== "string" || rootDir.trim() === "") throw new Error("项目目录不能为空");
  const raw = rootDir.trim();
  if (!isAbsolute(raw)) throw new Error("项目目录必须是绝对路径");
  return resolve(raw);
}

function clampChunkMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return PROJECT_CHUNK_MINUTES_DEFAULT;
  return Math.min(PROJECT_CHUNK_MINUTES_MAX, Math.max(PROJECT_CHUNK_MINUTES_MIN, Math.round(value)));
}

function readStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`projects.json 格式不正确：${where} 不是字符串数组`);
  return [...value];
}

function parseClipRefs(value: unknown, where: string): ProjectClipRef[] {
  if (!Array.isArray(value)) throw new Error(`projects.json 格式不正确：${where} 不是数组`);
  return value.map((item, index) => {
    if (!isObject(item)) throw new Error(`projects.json 格式不正确：${where}[${index}] 不是对象`);
    const { seq, videoId, topicId, file } = item;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= 0) throw new Error(`projects.json 格式不正确：${where}[${index}].seq`);
    if (typeof videoId !== "string" || typeof topicId !== "string" || typeof file !== "string") {
      throw new Error(`projects.json 格式不正确：${where}[${index}] 引用字段`);
    }
    return { seq, videoId, topicId, file };
  });
}

function parseRecord(raw: unknown, where: string): ProjectRecord {
  if (!isObject(raw)) throw new Error(`projects.json 格式不正确：${where} 不是对象`);
  const { id, name, rootDir, watchDir, monitoring, chunkMinutes, autoSlice, videoIds, clips, nextClipSeq, createdAt, updatedAt } = raw;
  if (typeof id !== "string" || id === "") throw new Error(`projects.json 格式不正确：${where}.id`);
  return {
    id,
    name: cleanName(name),
    rootDir: cleanRootDir(rootDir),
    watchDir: typeof watchDir === "string" && watchDir !== "" ? resolve(watchDir) : null,
    monitoring: monitoring === true,
    chunkMinutes: clampChunkMinutes(chunkMinutes),
    autoSlice: autoSlice !== false,
    // 旧 projects.json 没有这个字段；缺字段 / 非布尔都按开启处理（#155）
    semanticChunking: raw.semanticChunking !== false,
    videoIds: readStringArray(videoIds, `${where}.videoIds`),
    clips: parseClipRefs(clips, `${where}.clips`),
    nextClipSeq: typeof nextClipSeq === "number" && Number.isInteger(nextClipSeq) && nextClipSeq > 0 ? nextClipSeq : 1,
    createdAt: typeof createdAt === "string" ? createdAt : "",
    updatedAt: typeof updatedAt === "string" ? updatedAt : "",
  };
}

function readFileOrEmpty(path: string): { version: 1; projects: ProjectRecord[] } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: [] };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 不静默重建：用户的清单可能只是暂时损坏，覆盖会永远丢掉项目
    throw new Error("projects.json 不是合法 JSON（原文件已保留）");
  }
  if (!isObject(parsed) || parsed.version !== PROJECTS_VERSION || !Array.isArray(parsed.projects)) {
    throw new Error("projects.json 格式不正确：缺少 version 1 或 projects 数组");
  }
  return { version: 1, projects: parsed.projects.map((item, index) => parseRecord(item, `projects[${index}]`)) };
}

/**
 * 项目清单读写。每次调用都整份读取、改、整份原子写：清单很小，读穿磁盘换来
 * 「第二个进程/重启后的 store 立刻看到最新内容」，不需要缓存失效协议。
 */
export class ProjectStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  static atRoot(root: string): ProjectStore {
    return new ProjectStore(projectsFilePath(root));
  }

  list(): ProjectRecord[] {
    return readFileOrEmpty(this.path).projects;
  }

  get(id: string): ProjectRecord | undefined {
    return this.list().find((project) => project.id === id);
  }

  create(input: CreateProjectInput): ProjectRecord {
    const name = cleanName(input.name);
    const rootDir = cleanRootDir(input.rootDir);
    const projects = this.list();
    if (projects.some((project) => project.rootDir === rootDir)) throw new Error("项目目录已被其他项目使用");
    const id = input.id ?? randomUUID();
    if (projects.some((project) => project.id === id)) throw new Error(`项目 id 已存在：${id}`);
    const at = (input.now ?? new Date()).toISOString();
    const project: ProjectRecord = {
      id,
      name,
      rootDir,
      watchDir: null,
      monitoring: false,
      chunkMinutes: PROJECT_CHUNK_MINUTES_DEFAULT,
      autoSlice: true,
      semanticChunking: true,
      videoIds: [],
      clips: [],
      nextClipSeq: 1,
      createdAt: at,
      updatedAt: at,
    };
    this.write([...projects, project]);
    return project;
  }

  remove(id: string): boolean {
    const projects = this.list();
    const next = projects.filter((project) => project.id !== id);
    if (next.length === projects.length) return false;
    this.write(next);
    return true;
  }

  updateSettings(id: string, patch: ProjectSettingsPatch): ProjectRecord {
    return this.mutate(id, (project) => {
      if (patch.name !== undefined) project.name = cleanName(patch.name);
      if (patch.autoSlice !== undefined) project.autoSlice = patch.autoSlice;
      if (patch.chunkMinutes !== undefined) project.chunkMinutes = clampChunkMinutes(patch.chunkMinutes);
      if (patch.semanticChunking !== undefined) project.semanticChunking = patch.semanticChunking;
    });
  }

  startMonitor(id: string, watchDir: string): ProjectRecord {
    return this.mutate(id, (project) => {
      project.watchDir = cleanRootDir(watchDir);
      project.monitoring = true;
    });
  }

  addVideos(id: string, videoIds: readonly string[]): ProjectRecord {
    return this.mutate(id, (project) => {
      for (const videoId of videoIds) {
        if (videoId !== "" && !project.videoIds.includes(videoId)) project.videoIds.push(videoId);
      }
    });
  }

  recordClip(id: string, ref: ProjectClipRef): ProjectRecord {
    if (!Number.isInteger(ref.seq) || ref.seq <= 0) throw new Error("切片序号必须是正整数");
    return this.mutate(id, (project) => {
      if (project.clips.some((clip) => clip.seq === ref.seq)) throw new Error(`切片序号已存在：${ref.seq}`);
      project.clips.push({ ...ref });
      project.nextClipSeq = Math.max(project.nextClipSeq, ref.seq + 1);
    });
  }

  private mutate(id: string, change: (project: ProjectRecord) => void): ProjectRecord {
    const projects = this.list();
    const project = projects.find((item) => item.id === id);
    if (project === undefined) throw new Error(`未知项目：${id}`);
    change(project);
    project.updatedAt = new Date().toISOString();
    this.write(projects);
    return project;
  }

  private write(projects: ProjectRecord[]): void {
    writeJsonAtomic(this.path, { version: PROJECTS_VERSION, projects } satisfies ProjectsFile);
  }
}
