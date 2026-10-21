"use client";

import type { ReactNode } from "react";
import type { JobKind, JobSnapshot, JobStep } from "../../../../shared/ipc";
import { videoName } from "@/lib/format";
import { cn } from "@/lib/utils";

// monitoring-9 改造：抽出共用 ProgressBar（原型渐变进度条），
// 任务浮层 JobProgress 按 kind 显示标题。

export function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className="vn-progress"
    >
      <i style={{ width: `${clamped}%` }} />
    </div>
  );
}

const JOB_TITLES: Record<JobKind, string> = {
  extract: "提取进度",
  notes: "笔记生成",
  topics: "主题重建",
};

const STEP_LABELS: Record<JobStep, string> = {
  prepare: "准备",
  transcribe: "转写",
  "segment-topics": "主题分析",
  "generate-notes": "生成笔记",
  cleanup: "清理",
};

type CardContent = {
  stateLabel: string;
  stateTone: "run" | "idle" | "fail";
  showSpinner: boolean;
  body: ReactNode;
  actions: ReactNode;
};

function cardContent(job: JobSnapshot): CardContent {
  switch (job.state) {
    case "queued":
      return {
        stateLabel: "排队中",
        stateTone: "run",
        showSpinner: true,
        body: <span className="vn-hint">{videoName(job.sourcePath)}</span>,
        actions: null,
      };
    case "running": {
      const percent = job.total > 0 ? (job.done / job.total) * 100 : 0;
      return {
        stateLabel: STEP_LABELS[job.step],
        stateTone: "run",
        showSpinner: true,
        body: (
          <div className="flex flex-col gap-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="vn-hint tabular-nums">
                {job.done}/{job.total}
              </span>
              {job.detail !== null ? (
                <span className="vn-hint min-w-0 truncate">{job.detail}</span>
              ) : null}
            </div>
            <ProgressBar percent={percent} />
          </div>
        ),
        actions: null,
      };
    }
    case "succeeded":
      return {
        stateLabel: "完成",
        stateTone: "idle",
        showSpinner: false,
        body: (
          <span className="vn-hint">
            主题 {job.topicCount}，笔记 {job.noteCount}
            {job.cacheHits.length > 0 ? `，命中缓存 ${job.cacheHits.length} 项` : ""}
          </span>
        ),
        actions: null,
      };
    case "failed":
      return {
        stateLabel: "失败",
        stateTone: "fail",
        showSpinner: false,
        body: <span className="vn-hint break-words">{job.message}</span>,
        actions: null,
      };
    case "cancelled":
      return {
        stateLabel: "已取消",
        stateTone: "idle",
        showSpinner: false,
        body: null,
        actions: null,
      };
  }
}

const TONE_CLASS = {
  run: "text-[var(--vn-fg)]",
  idle: "text-[var(--vn-muted)]",
  fail: "text-[#fda4af]",
} as const;

export function JobProgress({
  job,
  onCancel,
  onClose,
}: {
  job: JobSnapshot;
  onCancel: () => void;
  onClose: () => void;
}) {
  const content = cardContent(job);
  return (
    <div
      data-testid="job-banner"
      className="vn-card fixed bottom-4 right-4 z-40 w-[360px] max-w-[calc(100vw-2rem)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[16px] font-[450] tracking-[-0.015em]">
          {JOB_TITLES[job.kind]}
        </h2>
        <span
          data-testid="job-state"
          className={cn(
            "inline-flex items-center gap-1.5 text-[14px] font-[450] tabular-nums",
            TONE_CLASS[content.stateTone],
          )}
        >
          {content.showSpinner ? (
            <span
              aria-hidden="true"
              className="inline-block size-2.5 shrink-0 rounded-full border border-current border-t-transparent animate-spin motion-reduce:animate-none"
            />
          ) : null}
          {content.stateLabel}
        </span>
      </div>
      {content.body !== null ? <div className="mt-2">{content.body}</div> : null}
      <div className="mt-3 flex justify-end gap-2">
        {job.state === "queued" || job.state === "running" ? (
          <button
            type="button"
            data-testid="job-cancel"
            onClick={onCancel}
            className="vn-btn sm"
          >
            取消
          </button>
        ) : null}
        {job.state === "succeeded" ||
        job.state === "failed" ||
        job.state === "cancelled" ? (
          <button
            type="button"
            data-testid="job-close"
            onClick={onClose}
            className="vn-btn sm"
          >
            关闭
          </button>
        ) : null}
      </div>
    </div>
  );
}
