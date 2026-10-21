"use client";

import type { ReactNode } from "react";
import type { JobSnapshot, JobStep } from "../../../../shared/ipc";
import { videoName } from "@/lib/format";
import { cn } from "@/lib/utils";

// monitoring-9（运行队列）的视觉常量，这里只保留进度卡用到的面板、行、状态与按钮。
const typeHeadingXs = "text-[16px]/[20px] font-[450] tracking-[-0.015em]";
const typeLabelSm = "text-[12px]/[16px] font-[450] tabular-nums";
const typeCaption = "text-[12px]/[16px] font-normal tabular-nums";
const text2 = "text-neutral-900/80 dark:text-neutral-100/80";
const text3 = "text-neutral-900/66 dark:text-neutral-100/66";
const statusWord =
  "inline-flex items-start gap-1.5 text-[14px]/[16px] font-[450] tabular-nums";
const statusRunning = "text-neutral-900 dark:text-neutral-100";
const statusIdle = "text-neutral-900/66 dark:text-neutral-100/66";
const statusFail = "text-[oklch(51%_0.18_26)] dark:text-[oklch(76%_0.14_26)]";
const arcLine = "flex h-lh shrink-0 items-center";
const runningArc =
  "inline-block size-2.5 shrink-0 rounded-full border border-current border-t-transparent animate-spin motion-reduce:animate-none";
const secondaryButton =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap select-none transition-[color,background-color,border-color,box-shadow,outline-color,scale,filter] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.98] active:duration-[60ms] motion-reduce:active:scale-100 disabled:cursor-not-allowed aria-busy:cursor-progress focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rb-accent,oklch(20.5%_0_0))] dark:focus-visible:outline-[var(--rb-accent,oklch(100%_0_0))] border border-neutral-900/12 bg-white text-neutral-900 shadow-[0_1px_2px_-1px_rgb(0_0_0/0.12)] hover:not-disabled:border-neutral-900/32 hover:not-disabled:bg-linear-to-b hover:not-disabled:from-neutral-900/3 hover:not-disabled:to-neutral-900/3 active:shadow-[inset_0_1px_2px_rgb(0_0_0/0.12)] disabled:border-neutral-900/8 disabled:text-neutral-900/40 disabled:shadow-none dark:border-neutral-100/14 dark:bg-neutral-900 dark:text-neutral-100 dark:shadow-[0_1px_2px_-1px_rgb(0_0_0/0.36)] dark:hover:not-disabled:border-neutral-100/32 dark:hover:not-disabled:from-neutral-100/3 dark:hover:not-disabled:to-neutral-100/3 dark:active:shadow-[inset_0_1px_2px_rgb(0_0_0/0.4)] dark:disabled:border-neutral-100/8 dark:disabled:text-neutral-100/40";
const buttonSm =
  "h-7 gap-1.5 rounded-[var(--rb-r-sm,6px)] px-3 text-[14px]/[16px] font-[450]";
const panel =
  "relative flex min-w-0 flex-col overflow-hidden rounded-[var(--rb-r-lg,10px)] border border-neutral-900/10 dark:border-neutral-100/14 bg-neutral-50 text-neutral-900 dark:text-neutral-100 dark:bg-neutral-900 shadow-[0_12px_32px_-8px_rgb(0_0_0/0.55)] dark:shadow-[0_12px_40px_-8px_rgb(0_0_0/0.75)]";
const itemRow =
  "relative flex min-h-10 w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-left text-neutral-900 dark:text-neutral-100";

const metaText = cn(typeCaption, text3);

const STEP_LABELS: Record<JobStep, string> = {
  prepare: "准备",
  transcribe: "转写",
  "segment-topics": "主题分析",
  "generate-notes": "生成笔记",
  cleanup: "清理",
};

function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-900/8 dark:bg-neutral-100/10"
    >
      <div
        className="h-full rounded-full bg-neutral-900 transition-[width] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none dark:bg-neutral-100"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

type CardContent = {
  stateLabel: string;
  stateTone: string;
  showSpinner: boolean;
  body: ReactNode;
  actions: ReactNode;
};

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="job-close"
      onClick={onClick}
      className={cn(secondaryButton, buttonSm)}
    >
      关闭
    </button>
  );
}

function cardContent(
  job: JobSnapshot,
  onCancel: () => void,
  onClose: () => void,
): CardContent {
  switch (job.state) {
    case "queued":
      return {
        stateLabel: "排队中",
        stateTone: statusRunning,
        showSpinner: true,
        body: <span className={metaText}>{videoName(job.sourcePath)}</span>,
        actions: null,
      };
    case "running": {
      const percent = job.total > 0 ? (job.done / job.total) * 100 : 0;
      return {
        stateLabel: STEP_LABELS[job.step],
        stateTone: statusRunning,
        showSpinner: true,
        body: (
          <div className="flex w-full flex-col gap-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className={cn(typeLabelSm, text2, "shrink-0")}>
                {job.done}/{job.total}
              </span>
              {job.detail ? (
                <span className={cn(metaText, "min-w-0 truncate")}>{job.detail}</span>
              ) : null}
            </div>
            <ProgressBar percent={percent} />
          </div>
        ),
        actions: (
          <button
            type="button"
            data-testid="job-cancel"
            onClick={onCancel}
            className={cn(secondaryButton, buttonSm)}
          >
            取消
          </button>
        ),
      };
    }
    case "succeeded":
      return {
        stateLabel: "完成",
        stateTone: statusRunning,
        showSpinner: false,
        body: (
          <span className={metaText}>
            主题 {job.topicCount}，笔记 {job.noteCount}
            {job.cacheHits.length > 0
              ? `，命中缓存 ${job.cacheHits.length} 项`
              : ""}
          </span>
        ),
        actions: <CloseButton onClick={onClose} />,
      };
    case "failed":
      return {
        stateLabel: "失败",
        stateTone: statusFail,
        showSpinner: false,
        body: (
          <span className={cn(metaText, "min-w-0 break-words")}>{job.message}</span>
        ),
        actions: <CloseButton onClick={onClose} />,
      };
    case "cancelled":
      return {
        stateLabel: "已取消",
        stateTone: statusIdle,
        showSpinner: false,
        body: null,
        actions: <CloseButton onClick={onClose} />,
      };
  }
}

export function JobProgress({
  job,
  onCancel,
  onClose,
}: {
  job: JobSnapshot;
  onCancel: () => void;
  onClose: () => void;
}) {
  const content = cardContent(job, onCancel, onClose);
  return (
    <div
      data-testid="job-banner"
      className={cn(panel, "fixed bottom-4 right-4 z-40 w-[360px] max-w-[calc(100vw-2rem)]")}
    >
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className={typeHeadingXs}>提取进度</h2>
          <span data-testid="job-state" className={cn(statusWord, content.stateTone)}>
            {content.showSpinner ? (
              <span className={arcLine}>
                <span aria-hidden="true" className={runningArc} />
              </span>
            ) : null}
            {content.stateLabel}
          </span>
        </div>
        {content.body !== null ? (
          <div className={itemRow}>{content.body}</div>
        ) : null}
        {content.actions !== null ? (
          <div className="flex justify-end">{content.actions}</div>
        ) : null}
      </div>
    </div>
  );
}
