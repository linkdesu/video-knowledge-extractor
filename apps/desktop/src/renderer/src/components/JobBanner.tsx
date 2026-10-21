import type { JobSnapshot, JobStep } from "../../../shared/ipc";
import { videoName } from "../lib/format";

const STEP_LABELS: Record<JobStep, string> = {
  prepare: "准备",
  transcribe: "转写",
  "segment-topics": "主题分析",
  "generate-notes": "生成笔记",
  cleanup: "清理",
};

export function JobBanner({ job, onCancel, onClose }: { job: JobSnapshot; onCancel: () => void; onClose: () => void }) {
  if (job.state === "queued") {
    return (
      <div className="jobbar jobbar--queued">
        <span className="jobbar__label">排队中</span>
        <span className="jobbar__text">{videoName(job.sourcePath)}</span>
      </div>
    );
  }
  if (job.state === "running") {
    return (
      <div className="jobbar jobbar--running">
        <span className="jobbar__label">{STEP_LABELS[job.step]}</span>
        <span className="jobbar__text">
          {job.done}/{job.total}
          {job.detail ? ` · ${job.detail}` : ""}
        </span>
        <button type="button" className="jobbar__cancel" onClick={onCancel}>
          取消
        </button>
      </div>
    );
  }
  if (job.state === "succeeded") {
    return (
      <div className="jobbar jobbar--succeeded">
        <span className="jobbar__label">完成</span>
        <span className="jobbar__text">
          主题 {job.topicCount}，笔记 {job.noteCount}
          {job.cacheHits.length > 0 ? `，命中缓存 ${job.cacheHits.length} 项` : ""}
        </span>
      </div>
    );
  }
  if (job.state === "failed") {
    return (
      <div className="jobbar jobbar--failed">
        <span className="jobbar__label">失败</span>
        <span className="jobbar__text">{job.message}</span>
        <button type="button" className="jobbar__close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>
    );
  }
  return (
    <div className="jobbar jobbar--cancelled">
      <span className="jobbar__label">已取消</span>
    </div>
  );
}
