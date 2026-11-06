import type {
  ProjectAnalysisTaskInfo,
  ProjectQueueState,
  ProjectTaskStatus,
} from "../../../shared/ipc";
import { fmtHms } from "./format";

/**
 * 切片队列 tab 的纯映射（#142，原型 L65-L69 / L131）：
 * 两条串行队列、每块两步、待确认主题、切片任务副行、底部「未切片内容时长」。
 */

export type StageState = ProjectTaskStatus;

/** 原型：一块分析 = 字幕解析 → 主题分析；界面只显示阶段状态，不显示百分比。 */
export const ANALYSIS_STAGES = ["字幕解析", "主题分析"] as const;

const STATUS_LABEL: Record<ProjectTaskStatus, string> = {
  waiting: "等待中",
  running: "进行中",
  done: "已完成",
  failed: "失败",
};

/** 失败是执行器真实终态（#126），如实标「失败」而不是回落到「等待中」。 */
export function taskStatusLabel(status: ProjectTaskStatus): string {
  return STATUS_LABEL[status];
}

/**
 * 「分析 N · 切片 N」：只数还在等或正在跑的任务，与原型 tag 同口径；都空闲时显示「队列空闲」。
 * 失败（#126）是终态，调度器不会再动它，算进待执行会让标题永远回不到空闲。
 */
export function queueCountLabel(queue: ProjectQueueState | null): string {
  const pending = (tasks: ReadonlyArray<{ status: ProjectTaskStatus }>) =>
    tasks.filter((task) => task.status === "waiting" || task.status === "running").length;
  const analysis = pending(queue?.analysis ?? []);
  const slices = pending(queue?.slices ?? []);
  return analysis === 0 && slices === 0 ? "队列空闲" : `分析 ${analysis} · 切片 ${slices}`;
}

/** 每个阶段的显示状态：已完成的任务两步都算完成。 */
export function analysisStages(
  job: Pick<ProjectAnalysisTaskInfo, "status" | "stage">,
): Array<{ name: string; state: StageState }> {
  return ANALYSIS_STAGES.map((name, index) => {
    if (job.status === "done") return { name, state: "done" as const };
    if (index < job.stage) return { name, state: "done" as const };
    if (job.status === "failed" && index === job.stage) return { name, state: "failed" as const };
    if (job.status === "running" && index === job.stage) return { name, state: "running" as const };
    return { name, state: "waiting" as const };
  });
}

/** `00:00:00–00:10:00`：分析分块覆盖的来源时间区间。 */
export function analysisRangeLabel(
  job: Pick<ProjectAnalysisTaskInfo, "startSeconds" | "endSeconds">,
): string {
  return `${fmtHms(job.startSeconds)}–${fmtHms(job.endSeconds)}`;
}

/** 待确认主题的来源行：`分析 #3 · 晚场.mp4 · 等待人工确认`；任务缺失时不编造文件名。 */
export function proposedTopicMeta(
  jobId: number,
  job: Pick<ProjectAnalysisTaskInfo, "name"> | undefined,
): string {
  return [
    `分析 #${jobId}`,
    job === undefined ? null : job.name,
    "等待人工确认",
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** 确认弹窗副标题：`晚场.mp4 · 分析区间 00:00:00–00:10:00`。 */
export function proposedTopicSource(
  job: Pick<ProjectAnalysisTaskInfo, "name" | "startSeconds" | "endSeconds">,
): string {
  return `${job.name} · 分析区间 ${analysisRangeLabel(job)}`;
}

/** 待确认区的一行：AI 建议的行加来源行文案；不自动弹窗、不占队列。 */
export type PendingTopic = {
  topicKey: string;
  jobId: number;
  title: string;
  lineIds: string[];
  sourceLine: string;
};

/** 待确认主题平铺：保持 main 快照顺序（分析队列平铺），补上来源行文案；不自动弹窗、不占队列。 */
export function pendingTopics(queue: ProjectQueueState | null): PendingTopic[] {
  const jobs = queue?.analysis ?? [];
  return (queue?.proposed ?? []).map((topic) => ({
    topicKey: topic.topicKey,
    jobId: topic.jobId,
    title: topic.title,
    lineIds: [...topic.lineIds],
    sourceLine: proposedTopicMeta(topic.jobId, jobs.find((job) => job.id === topic.jobId)),
  }));
}

/** 切片任务副行：`3 行字幕 · 00:00:45`（累计时长，不含未选间隔）。 */
export function sliceTaskMeta(task: { lineCount: number; durationSeconds: number }): string {
  return `${task.lineCount} 行字幕 · ${fmtHms(task.durationSeconds)}`;
}

/**
 * 队列底部「未切片内容时长」：只列已加入整理的视频，多个用「；」连接。
 * 重启后控制器还没 `startOrganize`，快照里的 `added` 仍是 false；项目清单 `videoIds` 是
 * 「已加入」的真相源，两处任一为真就列出来，不能和配置页的状态打架。
 */
export function queueFootline(
  queue: ProjectQueueState | null,
  joinedIds: readonly string[] = [],
): string {
  const joined = new Set(joinedIds);
  const lines = (queue?.files ?? [])
    .filter((file) => file.added || joined.has(file.id))
    .map((file) => `${file.name}：未切片内容时长 ${fmtHms(file.unslicedSeconds)}`);
  return lines.length === 0 ? "未切片内容时长：尚未加入视频。" : lines.join("；");
}
