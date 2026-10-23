import type { JobSnapshot, TopicInfo } from "../../../shared/ipc";
import { ProgressBar } from "@/rbp/blocks/monitoring-9";
import { fmtElapsed } from "@/lib/format";

export const TOPIC_STATUS_LABEL: Record<TopicInfo["status"], string> = {
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

/** 生成中主题的时间线：实时任务快照优先，否则回退主题的 startedAt / elapsedSeconds。 */
export function generatingProgress(
  topic: TopicInfo,
  job: JobSnapshot | null,
  now: number,
): { percent: number | null; elapsedSeconds: number } | null {
  if (topic.status !== "generating") return null;
  const liveJob =
    job !== null && job.state === "running" && job.topicId === topic.id ? job : null;
  const startedIso = liveJob?.startedAt ?? topic.startedAt;
  const elapsedSeconds =
    startedIso === null
      ? (topic.elapsedSeconds ?? 0)
      : Math.max(0, Math.floor((now - new Date(startedIso).getTime()) / 1000));
  const percent = liveJob?.topicPercent ?? null;
  return { percent, elapsedSeconds };
}

type NoteListProps = {
  topics: TopicInfo[];
  selectedId: string | null;
  onSelect: (topicId: string) => void;
  job: JobSnapshot | null;
  now: number;
};

export function NoteList({ topics, selectedId, onSelect, job, now }: NoteListProps) {
  return (
    <div className="flex max-h-full flex-col gap-2 overflow-y-auto p-2">
      {topics.map((t) => {
        const prog = generatingProgress(t, job, now);
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
            <h4 className="text-[14px] font-[450]">{t.title}</h4>
            <span className={`mt-1.5 inline-block text-[12px] tabular-nums ${STATUS_TONE[t.status]}`}>
              {TOPIC_STATUS_LABEL[t.status]}
            </span>
            {prog !== null ? (
              <div className="mt-1.5">
                <ProgressBar percent={prog.percent ?? 0} />
                <div className="mt-1 flex justify-between text-[10px] tabular-nums text-neutral-900/66 dark:text-neutral-100/66">
                  <span>已用 {fmtElapsed(prog.elapsedSeconds)}</span>
                  {prog.percent !== null ? <span>{Math.round(prog.percent)}%</span> : null}
                </div>
              </div>
            ) : null}
            {t.status === "failed" && t.error !== null ? (
              <div className="mt-1 text-[11px] text-[#fda4af]">{t.error}</div>
            ) : null}
            <div className="mt-2 flex justify-end">
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
