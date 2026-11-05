/** 导航改名后的面包屑、项目页 tab、公共日志摘要与列表统计（#127）；只做纯映射，不碰 DOM。 */
import type { ProjectDetail } from "../../../shared/ipc";

export type ProjectTab = "config" | "queue" | "output";

export const PROJECT_TAB_LABEL: Record<ProjectTab, string> = {
  config: "项目配置",
  queue: "切片队列",
  output: "切片产出",
};

export type CrumbState =
  | { page: "notes" }
  | { page: "projects" }
  | { page: "project"; name: string; tab: ProjectTab };

export function breadcrumbParts(state: CrumbState): string[] {
  if (state.page === "notes") return ["整理笔记"];
  if (state.page === "projects") return ["整理切片", "项目管理"];
  return ["整理切片", state.name, PROJECT_TAB_LABEL[state.tab]];
}

/** 原型 L155：tablist 上左右循环、Home / End 到两端；其它按键交给浏览器。 */
export function tabIndexAfterKey(
  index: number,
  key: string,
  count: number,
): number | null {
  if (index < 0 || index >= count) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  return null;
}

/** 原型 L133 折叠摘要：`分析 N 进行中 · 切片 N 进行中 · N 主题待确认 · 最新事件`。 */
export function projectLogSummary(
  detail: Pick<ProjectDetail, "queue" | "events">,
): string {
  const queue = detail.queue;
  const analysisRunning = (queue?.analysis ?? []).filter(
    (task) => task.status === "running",
  ).length;
  const sliceRunning = (queue?.slices ?? []).filter(
    (task) => task.status === "running",
  ).length;
  const latest = detail.events[0]?.text ?? "尚未监控";
  return [
    `分析 ${analysisRunning} 进行中`,
    `切片 ${sliceRunning} 进行中`,
    `${queue?.proposed.length ?? 0} 主题待确认`,
    latest,
  ].join(" · ");
}

/** 原型 L129 项目行统计：视频、待处理任务、待确认主题、切片。 */
export function projectStatsLine(
  summary: Pick<
    ProjectDetail,
    "videoCount" | "pendingTaskCount" | "proposedTopicCount" | "clipCount"
  >,
): string {
  return [
    `${summary.videoCount} 个视频`,
    `${summary.pendingTaskCount} 个待处理任务`,
    `${summary.proposedTopicCount} 个待确认主题`,
    `${summary.clipCount} 条切片`,
  ].join(" · ");
}
