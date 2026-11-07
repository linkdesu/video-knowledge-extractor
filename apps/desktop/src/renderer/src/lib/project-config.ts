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

/** 修改时间显示与排序的静默防抖（#121 第 20 条）：连续更新 500ms 后合并一次。 */
export const SORT_DEBOUNCE_MS = 500;
/** 文件持续增长时最长 2 秒必须刷新一次，避免界面一直不跳。 */
export const SORT_MAX_WAIT_MS = 2_000;

export type SortTimers = {
  now: () => number;
  setTimeout: (run: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
};

const DEFAULT_SORT_TIMERS: SortTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms) as unknown as number,
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

/** 下一次提交前还要等多久：尾随 500ms，但从第一次未提交的更新起最多 2 秒。 */
export function sortRefreshDelay(pendingSinceMs: number, nowMs: number): number {
  const elapsed = Math.max(0, nowMs - pendingSinceMs);
  return Math.min(SORT_DEBOUNCE_MS, Math.max(0, SORT_MAX_WAIT_MS - elapsed));
}

/**
 * 排序刷新调度器（原型 `scheduleSort`）：连续 push 只提交最后一次，
 * 静默 500ms 或从首次更新起满 2 秒时提交。定时器可注入，测试不用真实等待。
 */
export class SortRefreshScheduler<T> {
  private pendingSince: number | null = null;
  private latest: T | undefined;
  private handle: number | null = null;
  private readonly commit: (value: T) => void;
  private readonly timers: SortTimers;

  constructor(commit: (value: T) => void, timers: SortTimers = DEFAULT_SORT_TIMERS) {
    this.commit = commit;
    this.timers = timers;
  }

  push(value: T): void {
    this.latest = value;
    const now = this.timers.now();
    if (this.pendingSince === null) this.pendingSince = now;
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = this.timers.setTimeout(() => this.flush(), sortRefreshDelay(this.pendingSince, now));
  }

  flush(): void {
    if (this.pendingSince === null) return;
    const value = this.latest as T;
    this.pendingSince = null;
    this.latest = undefined;
    this.handle = null;
    this.commit(value);
  }

  cancel(): void {
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.pendingSince = null;
    this.latest = undefined;
    this.handle = null;
  }
}

/**
 * 防抖视图：显示用的修改时间与顺序取上一轮提交的快照，
 * 其余字段（整理状态、已处理、已加入）始终取最新值；本轮新出现的文件先排末尾。
 */
export function mergeDirectoryView(
  latest: readonly ProjectDirectoryFile[],
  snapshot: readonly ProjectDirectoryFile[],
): ProjectDirectoryFile[] {
  const live = new Map(latest.map((file) => [file.videoId, file] as const));
  const shownIds = new Set(snapshot.map((file) => file.videoId));
  const ordered: ProjectDirectoryFile[] = [];
  for (const shown of snapshot) {
    const current = live.get(shown.videoId);
    if (current !== undefined) ordered.push({ ...current, modifiedAt: shown.modifiedAt });
  }
  return [...ordered, ...latest.filter((file) => !shownIds.has(file.videoId))];
}
