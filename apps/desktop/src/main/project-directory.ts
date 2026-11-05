import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { videoIdFor } from "@video-notes/core";
import type { ProjectDirectoryFile, ProjectOrganizeStatus } from "../shared/ipc";

/**
 * 与 `dialog:pick-video` 同一份扩展名清单：监控目录里只有这些文件进表。
 * 大小写不敏感（macOS 上常见 `MOV`），目录与其它文件一律忽略。
 */
export const DIRECTORY_MEDIA_EXTENSIONS: readonly string[] = [
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
  ".avi",
  ".flv",
  ".ts",
  ".mts",
  ".m2ts",
  ".m4a",
  ".mp3",
  ".wav",
  ".flac",
  ".wma",
  ".wmv",
];

export type DirectoryStatus = {
  added: boolean;
  organizeStatus: ProjectOrganizeStatus;
  processedSeconds: number;
};

/**
 * 监控目录的一次性快照（#128，原型 L60 / L94 / L130）：只读一层目录，按修改时间倒序；
 * 同一个修改时间保持目录枚举顺序（新文件排在已有文件之后）。时长从视频库注入，
 * 未导入的文件为 null —— 扫描本身不跑 ffprobe，避免每次推送都探测整目录。
 */
export function scanProjectDirectory(options: {
  watchDir: string;
  statuses: ReadonlyMap<string, DirectoryStatus>;
  /** 视频库已知的时长；未导入返回 undefined。 */
  durationOf?: (videoId: string) => number | null | undefined;
}): ProjectDirectoryFile[] {
  const { watchDir, statuses, durationOf } = options;
  let names: string[];
  try {
    names = readdirSync(watchDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    // 目录还没建、被删掉或没有权限：表格显示空列表，监控状态保持现状
    return [];
  }

  const files: ProjectDirectoryFile[] = [];
  for (const name of names) {
    if (!DIRECTORY_MEDIA_EXTENSIONS.includes(extname(name).toLowerCase())) continue;
    const path = join(watchDir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const videoId = videoIdFor(path);
    const status = statuses.get(videoId);
    files.push({
      videoId,
      name,
      path,
      sizeBytes: stat.size,
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
      durationSeconds: durationOf?.(videoId) ?? null,
      added: status?.added ?? false,
      organizeStatus: status?.organizeStatus ?? "unorganized",
      processedSeconds: status?.processedSeconds ?? 0,
    });
  }

  // Array.prototype.sort 自 ES2019 起稳定：同一修改时间保持 readdir 的相对顺序
  return files.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
}
