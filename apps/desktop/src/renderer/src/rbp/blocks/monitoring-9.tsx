"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { JobKind, JobSnapshot, JobStep } from "../../../../shared/ipc";
import { fmtElapsed, videoName } from "@/lib/format";
import { cn } from "@/lib/utils";

// monitoring-9 改造：任务浮层 JobProgress 按 kind 显示标题；
// 任务浮层不再用进度条/百分比，用「n/m」与已用时长（r37）。
// r45：右下角 fixed 浮层 + 内容区动态底部留白，绝不挤压 .vn-shell 100vh。
// ProgressBar 保留导出：库页等其它调用方仍在使用。

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

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function runningBody(job: Extract<JobSnapshot, { state: "running" }>, now: number): ReactNode {
  const elapsed = Math.max(0, Math.floor((now - new Date(job.startedAt).getTime()) / 1000));
  const isNotesGen = job.kind === "notes" && job.step === "generate-notes";
  const detail = job.detail !== null ? `：${job.detail}` : "";
  return (
    <div className="vn-hint tabular-nums">
      {isNotesGen ? (
        <>
          正在生成中（{job.done + 1}/{job.total}）
          {detail}
          {" · 已用 "}
          {fmtElapsed(elapsed)}
        </>
      ) : (
        <>
          {STEP_LABELS[job.step]}
          {detail}
          {" · 已用 "}
          {fmtElapsed(elapsed)}
        </>
      )}
    </div>
  );
}

function cardContent(job: JobSnapshot, now: number): CardContent {
  switch (job.state) {
    case "queued":
      return {
        stateLabel: "排队中",
        stateTone: "run",
        showSpinner: true,
        body: <span className="vn-hint">{videoName(job.sourcePath)}</span>,
        actions: null,
      };
    case "running":
      return {
        stateLabel: STEP_LABELS[job.step],
        stateTone: "run",
        showSpinner: true,
        body: runningBody(job, now),
        actions: null,
      };
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

const COMPACT_VIEWPORT_MAX_HEIGHT = 700;

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
  // running 时本地时钟每秒走一格，用于「已用 MM:SS」；卸载时清理。
  const now = useNow(job.state === "running");
  const [logsExpanded, setLogsExpanded] = useState(
    () => window.innerHeight > COMPACT_VIEWPORT_MAX_HEIGHT,
  );
  const content = cardContent(job, now);
  const bannerRef = useRef<HTMLDivElement | null>(null);
  // tail -f 跟随：初始贴底；用户上滚即停，滚回底部（24px 内）在下次追加时恢复。
  const logRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  useEffect(() => {
    setLogsExpanded(window.innerHeight > COMPACT_VIEWPORT_MAX_HEIGHT);
    followRef.current = true;
  }, [job.jobId]);
  useEffect(() => {
    let wasCompact = window.innerHeight <= COMPACT_VIEWPORT_MAX_HEIGHT;
    const onResize = () => {
      const isCompact = window.innerHeight <= COMPACT_VIEWPORT_MAX_HEIGHT;
      if (isCompact === wasCompact) return;
      wasCompact = isCompact;
      setLogsExpanded(!isCompact);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    const banner = bannerRef.current;
    if (banner === null) return;
    const rootStyle = document.documentElement.style;
    const updateInset = () => {
      const inset = Math.max(360, Math.ceil(banner.getBoundingClientRect().height) + 32);
      rootStyle.setProperty("--vn-job-inset", `${inset}px`);
    };
    updateInset();
    const observer = new ResizeObserver(updateInset);
    observer.observe(banner);
    return () => {
      observer.disconnect();
      rootStyle.removeProperty("--vn-job-inset");
    };
  }, []);
  useEffect(() => {
    const el = logRef.current;
    if (el !== null && followRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [job.jobId, job.logs.length, logsExpanded]);
  return (
    <div
      data-testid="job-banner"
      ref={bannerRef}
      className="vn-card fixed bottom-4 right-4 z-40 w-[440px] max-w-[calc(100vw-2rem)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[16px] font-[450] tracking-[-0.015em]">
          {JOB_TITLES[job.kind]}
        </h2>
        <div className="flex items-center gap-2">
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
          {job.logs.length > 0 ? (
            <button
              type="button"
              data-testid="job-toggle-log"
              aria-expanded={logsExpanded}
              onClick={() => setLogsExpanded((expanded) => !expanded)}
              className="vn-btn sm"
            >
              {logsExpanded ? "收起日志" : "展开日志"}
            </button>
          ) : null}
        </div>
      </div>
      {content.body !== null ? (
        <div className="mt-2">{content.body}</div>
      ) : null}
      {logsExpanded && job.logs.length > 0 ? (
        <div
          data-testid="job-log-tail"
          className="vn-model-log flat"
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            followRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
          }}
          style={{ minHeight: 84, maxHeight: 140 }}
        >
          {job.logs.map((line, i) => (
            <div key={i} className="vn-model-log-line" data-testid="job-log-line">
              {line}
            </div>
          ))}
        </div>
      ) : null}
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
