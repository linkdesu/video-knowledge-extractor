import type { JobSnapshot } from "../../../shared/ipc";
import { fmtElapsed } from "./format";

/** 主题在界面里的单一状态模型（r37）：两个页面、两个列表共用，规则不重复编码。 */
export type TopicUiState =
  | { kind: "generating" }
  | { kind: "queued" }
  | { kind: "done" }
  | { kind: "failed"; reason: string }
  | { kind: "needs-rerun"; reason: string | null }
  | { kind: "proposed" };

/** 在途 notes 任务的 generate-notes 步骤正针对该主题时视为生成中（磁盘状态刷新前也成立）。 */
const notesJobForTopic = (topicId: string, job: JobSnapshot | null) =>
  job !== null &&
  job.state === "running" &&
  job.kind === "notes" &&
  job.step === "generate-notes" &&
  job.topicId === topicId;

/** 生成中：磁盘 status=generating，或在途 notes 任务正对该主题。 */
export function topicGenerating(
  topic: { id: string; status: string },
  job: JobSnapshot | null,
): boolean {
  return topic.status === "generating" || notesJobForTopic(topic.id, job);
}

/** 主题 UI 状态：generating 优先，其余按磁盘状态映射；failed 原因缺省、needs-rerun 原因可空。 */
export function topicUiState(
  topic: { status: string; error: string | null; startedAt: string | null },
  generating: boolean,
): TopicUiState {
  if (generating) return { kind: "generating" };
  switch (topic.status) {
    case "queued":
      return { kind: "queued" };
    case "done":
      return { kind: "done" };
    case "failed":
      return { kind: "failed", reason: topic.error ?? "未知原因" };
    case "needs-rerun":
      return { kind: "needs-rerun", reason: topic.error };
    case "proposed":
      return { kind: "proposed" };
    default:
      return { kind: "failed", reason: "未知原因" };
  }
}

/** 状态文案：生成中带已用时长（fmtElapsed），失败/需重跑带原因（有原因才带）。 */
export function topicStateLabel(state: TopicUiState, elapsedSeconds: number): string {
  switch (state.kind) {
    case "generating":
      return `正在生成中… · 已用 ${fmtElapsed(elapsedSeconds)}`;
    case "queued":
      return "排队等待中…";
    case "done":
      return "已完成";
    case "failed":
      return `生成失败：${state.reason}`;
    case "needs-rerun":
      return state.reason === null ? "待重新生成" : `待重新生成：${state.reason}`;
    case "proposed":
      return "待确认";
  }
}

/** 步骤门控：至少一个主题 done 才允许进入笔记页。 */
export function hasReadyNote(topics: { status: string }[]): boolean {
  return topics.some((t) => t.status === "done");
}
