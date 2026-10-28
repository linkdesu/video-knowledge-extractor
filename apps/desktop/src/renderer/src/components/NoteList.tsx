import type { JobSnapshot, TopicInfo } from "../../../shared/ipc";
import { topicElapsedSeconds, topicGenerating, topicStateLabel, topicUiState } from "@/lib/topic-state";

const TOPIC_STATUS_LABEL: Record<TopicInfo["status"], string> = {
  done: "完成",
  generating: "生成中",
  queued: "排队",
  proposed: "待确认",
  "needs-rerun": "需重跑",
  failed: "失败",
};

const STATUS_TONE: Record<TopicInfo["status"], string> = {
  done: "text-[#34d399]",
  generating: "text-[#60a5fa]",
  queued: "text-[#fbbf24]",
  proposed: "text-[#22d3ee]",
  "needs-rerun": "text-[#fbbf24]",
  failed: "text-[#fda4af]",
};

type NoteListProps = {
  topics: TopicInfo[];
  selectedId: string | null;
  onSelect: (topicId: string) => void;
  onRegenerate: (topicId: string) => void;
  job: JobSnapshot | null;
  now: number;
};

export function NoteList({ topics, selectedId, onSelect, onRegenerate, job, now }: NoteListProps) {
  return (
    <div className="flex max-h-full flex-col gap-2 overflow-y-auto p-2">
      {topics.map((t) => {
        const state = topicUiState(t, topicGenerating(t, job));
        // 生成中/排队中：状态行用实时文案（磁盘 status 可能仍是上一轮的 done，不并列展示以免自相矛盾）。
        const liveState = state.kind === "generating" || state.kind === "queued";
        return (
          <div
            key={t.id}
            data-testid={`note-row`}
            className={`rounded-[10px] border px-3 py-2 ${
              selectedId === t.id
                ? "border-neutral-900/25 bg-neutral-900/4 dark:border-neutral-100/30 dark:bg-neutral-100/4"
                : "border-neutral-900/10 dark:border-neutral-100/14"
            }`}
          >
            <h2 className="text-[14px] font-[450]">{t.title}</h2>
            <span className={`mt-1.5 inline-block text-[12px] tabular-nums ${STATUS_TONE[t.status]}`}>
              {liveState ? topicStateLabel(state, topicElapsedSeconds(t, job, now)) : TOPIC_STATUS_LABEL[t.status]}
            </span>
            {t.status === "failed" && t.error !== null ? (
              <div className="mt-1 text-[11px] text-[#fda4af]">{t.error}</div>
            ) : null}
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                data-testid={`topic-regenerate-${t.id}`}
                onClick={() => onRegenerate(t.id)}
                disabled={state.kind === "generating"}
                className="h-7 cursor-pointer whitespace-nowrap rounded-[6px] border border-neutral-900/12 px-3 text-[14px] font-[450] transition-[color,background-color,border-color,box-shadow] duration-[120ms] hover:border-neutral-900/32 hover:bg-neutral-900/3 dark:border-neutral-100/14 dark:hover:border-neutral-100/32 dark:hover:bg-neutral-100/3 disabled:cursor-default disabled:opacity-50"
              >
                {state.kind === "generating" ? "生成中…" : "重新生成"}
              </button>
              <button
                type="button"
                data-testid="note-open"
                onClick={() => onSelect(t.id)}
                className="h-7 cursor-pointer whitespace-nowrap rounded-[6px] border border-neutral-900/12 px-3 text-[14px] font-[450] transition-[color,background-color,border-color,box-shadow] duration-[120ms] hover:border-neutral-900/32 hover:bg-neutral-900/3 dark:border-neutral-100/14 dark:hover:border-neutral-100/32 dark:hover:bg-neutral-100/3"
              >
                查看笔记
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
