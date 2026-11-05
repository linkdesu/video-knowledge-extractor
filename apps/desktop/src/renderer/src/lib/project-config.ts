import type { ProjectDirectoryFile, ProjectOrganizeStatus } from "../../../shared/ipc";
import { fmtBytes } from "./format";

/** 项目配置 tab 的纯文案映射（#128，原型 L53-L64 / L130 / L148-L151）。不碰 DOM。 */

/** 三种整理状态（#121 第 26 条）；没有「录制状态」这类第四种。 */
export const ORGANIZE_STATUS_LABEL: Record<ProjectOrganizeStatus, string> = {
  unorganized: "未整理",
  organizing: "持续整理中",
  finished: "整理已结束",
};

/** 原型 `configure()`：读不出数字回落 10 分钟，其余四舍五入后夹到 1–30。 */
export function clampChunkMinutes(value: number | string): number {
  const raw = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isFinite(raw) || (typeof value === "string" && value.trim() === "")) return 10;
  return Math.min(30, Math.max(1, Math.round(raw)));
}

/** 原型 L148「填入示例」：`<项目目录>/recordings`，沿用项目目录自己的分隔符。 */
export function exampleDirectory(rootDir: string): string {
  const trimmed = rootDir.replace(/[\\/]+$/, "");
  const separator = rootDir.includes("\\") ? "\\" : "/";
  return `${trimmed}${separator}recordings`;
}

export function monitorStatusLabel(monitoring: boolean): string {
  return monitoring ? "监控中" : "尚未监控";
}

/** 原型 `file-count`：`N 个文件`。 */
export function directoryCountLabel(count: number): string {
  return `${count} 个文件`;
}

/** 原型 `stamp()`：HH:MM:SS，非法值按 0。 */
export function hms(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

/** 状态列小字：`已处理 00:10:00`（原型 L130）。 */
export function processedLabel(seconds: number): string {
  return `已处理 ${hms(seconds)}`;
}

/** 表格「大小 / 时长」列：时长未知（未导入 / 读不出）显示 `—`。 */
export function fileMeta(
  file: Pick<ProjectDirectoryFile, "sizeBytes" | "durationSeconds">,
): { size: string; duration: string } {
  return {
    size: fmtBytes(file.sizeBytes),
    duration: file.durationSeconds === null ? "—" : hms(file.durationSeconds),
  };
}

/**
 * 修改时间倒序；同一个修改时间沿用上一轮的相对顺序，新文件排在末尾（#121 第 20 条）。
 * 上一轮顺序来自界面自己保存的列表，`previousOrder` 里没有的 id 视为最新出现。
 */
export function sortDirectoryFiles(
  files: readonly ProjectDirectoryFile[],
  previousOrder: readonly string[],
): ProjectDirectoryFile[] {
  const rank = new Map(previousOrder.map((videoId, index) => [videoId, index] as const));
  const modified = new Map(files.map((file) => [file.videoId, Date.parse(file.modifiedAt)] as const));
  return [...files].sort((a, b) => {
    const diff = (modified.get(b.videoId) ?? 0) - (modified.get(a.videoId) ?? 0);
    if (diff !== 0 && Number.isFinite(diff)) return diff;
    return (rank.get(a.videoId) ?? previousOrder.length) - (rank.get(b.videoId) ?? previousOrder.length);
  });
}

/** 表头全选：没有文件时禁用；部分选中是 indeterminate（原型 L130）。 */
export function selectAllState(
  files: readonly ProjectDirectoryFile[],
  selected: ReadonlySet<string>,
): { checked: boolean; indeterminate: boolean; disabled: boolean } {
  const chosen = files.filter((file) => selected.has(file.videoId)).length;
  return {
    checked: files.length > 0 && chosen === files.length,
    indeterminate: chosen > 0 && chosen < files.length,
    disabled: files.length === 0,
  };
}

/** 「开始整理」：只有勾选且尚未加入的文件算待办；有已加入的改文案为「加入整理」。 */
export function startButtonState(
  files: readonly ProjectDirectoryFile[],
  selected: ReadonlySet<string>,
): { disabled: boolean; label: string } {
  const fresh = files.filter((file) => selected.has(file.videoId) && !file.added).length;
  const anyAdded = files.some((file) => file.added);
  return {
    disabled: fresh === 0,
    label: `${anyAdded ? "加入整理" : "开始整理"}${fresh > 0 ? ` (${fresh})` : ""}`,
  };
}

/** 表格底部提示：`已选 N 个 · 已加入 M 个`（原型 L130）。 */
export function selectionSummary(
  files: readonly ProjectDirectoryFile[],
  selected: ReadonlySet<string>,
): string {
  const chosen = files.filter((file) => selected.has(file.videoId)).length;
  const added = files.filter((file) => file.added).length;
  return `已选 ${chosen} 个 · 已加入 ${added} 个`;
}

/** 空表提示（原型 L130 的唯一空态文案）。 */
export function directoryEmptyHint(): string {
  return "开始监控后显示视频，勾选后点击开始整理。";
}
