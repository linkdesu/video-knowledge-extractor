import { useState } from "react";
import { createPortal } from "react-dom";
import type { JobSnapshot, JobStep, LibraryVideo, VideoStatus } from "../../../shared/ipc";
import DropZone from "../rbp/blocks/empty-state-5";
import { ProgressBar } from "../rbp/blocks/monitoring-9";
import { fmtBytes, fmtClock } from "../lib/format";

const STATUS_TAG: Record<VideoStatus, { label: string; cls: string }> = {
  done: { label: "已完成", cls: "vn-tag ok" },
  "pending-confirm": { label: "待确认主题", cls: "vn-tag accent" },
  partial: { label: "部分完成", cls: "vn-tag warn" },
  "in-progress": { label: "处理中", cls: "vn-tag warn" },
  "needs-rerun": { label: "需重跑", cls: "vn-tag warn" },
  failed: { label: "失败", cls: "vn-tag err" },
};

const STEP_LABEL: Record<JobStep, string> = {
  prepare: "准备",
  normalize: "格式转换",
  transcribe: "转写",
  "segment-topics": "主题分析",
  "generate-notes": "生成笔记",
  cleanup: "清理",
};

function importLabel(iso: string | null): string {
  if (iso === null) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const now = new Date();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return `今天 ${hm} 导入`;
  if (d.toDateString() === yest.toDateString()) return `昨天 ${hm} 导入`;
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
  return md;
}

export function LibraryPage({
  videos,
  job,
  loading,
  loadError,
  onReload,
  onOpenVideo,
  onImport,
  onImportPath,
  onRerun,
  onDelete,
}: {
  videos: LibraryVideo[];
  job: JobSnapshot | null;
  loading: boolean;
  loadError: string | null;
  onReload: () => void;
  onOpenVideo: (video: LibraryVideo, page: "topics" | "notes") => void;
  onImport: () => void;
  onImportPath: (path: string) => void;
  onRerun: (video: LibraryVideo) => void;
  onDelete: (video: LibraryVideo) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState<LibraryVideo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const confirmDelete = () => {
    const target = deleting;
    if (target === null) return;
    setDeleteBusy(true);
    void onDelete(target)
      .then(() => {
        setDeleting(null);
      })
      .finally(() => setDeleteBusy(false));
  };
  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <h1 className="vn-h1">
          <span className="vn-gtext">视频库</span>
        </h1>
        <p className="vn-sub">导入视频，自动转写、拆分主题、生成带图笔记。</p>
      </div>

      <DropZone
        onImport={onImport}
        onImportPath={onImportPath}
        busy={job !== null && (job.state === "queued" || job.state === "running")}
      />

      {loading ? (
        <div className="vn-hint" style={{ marginTop: 18 }}>
          加载库中…
        </div>
      ) : loadError !== null ? (
        <div className="vn-hint" style={{ marginTop: 18 }}>
          加载库失败：{loadError}
          <button
            type="button"
            className="vn-btn sm"
            style={{ marginLeft: 12 }}
            onClick={onReload}
          >
            重试
          </button>
        </div>
      ) : null}

      {videos.length > 0 ? (
        <div className="vn-grid vn-vcards" style={{ marginTop: 18 }}>
          {videos.map((v) => {
            // 运行中的视频一律不显示文档里的终态：重跑排队到 worker 起来之间，video.json 还是上一轮的 done。
            const running =
              job !== null &&
              job.videoId === v.id &&
              (job.state === "queued" || job.state === "running")
                ? job
                : null;
            const percent =
              running !== null && running.state === "running" && running.total > 0
                ? (running.done / running.total) * 100
                : 0;
            const label =
              running === null
                ? STATUS_TAG[v.status].label
                : running.state === "queued"
                  ? "排队中"
                  : percent > 0
                    ? running.step === "normalize"
                      ? `格式转换 ${Math.round(percent)}%`
                      : running.step === "transcribe"
                        ? `转写中 ${Math.round(percent)}%`
                        : `处理中 ${Math.round(percent)}%`
                    : `${STEP_LABEL[running.step]}中`;
            const cls = running !== null ? "vn-tag warn" : STATUS_TAG[v.status].cls;
            return (
              <div key={v.id} className="vn-card vn-vcard" data-testid="video-card">
                <div className="vn-thumb">
                  {v.coverUrl !== null ? (
                    <img
                      data-testid="video-cover"
                      className="vn-thumb-img"
                      src={v.coverUrl}
                      alt=""
                    />
                  ) : null}
                  <span className="vn-dur">
                    {v.durationSeconds !== null ? fmtClock(v.durationSeconds) : "—"}
                  </span>
                </div>
                <div className="vn-vbody">
                  <span className="vn-title" data-testid="video-title">
                    {v.title}
                  </span>
                  <div className="vn-meta">
                    <span>{importLabel(v.importedAt)}</span>
                    <span>{v.sizeBytes !== null ? fmtBytes(v.sizeBytes) : "—"}</span>
                    {v.resolution !== null ? (
                      <span data-testid="video-resolution">
                        {v.resolution.width}×{v.resolution.height}
                      </span>
                    ) : null}
                    {v.hasVideo === false ? (
                      <span data-testid="video-audio-only">纯音频</span>
                    ) : null}
                    {v.topicCount > 0 ? <span>{v.topicCount} 个主题</span> : null}
                  </div>
                  <div
                    className="vn-row vn-between vn-vactions"
                    data-testid="video-card-foot"
                    style={{ marginTop: "auto" }}
                  >
                    <span data-testid="video-status" className={cls}>
                      {label}
                    </span>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "nowrap",
                        whiteSpace: "nowrap",
                      }}
                    >
                    {v.status === "failed" ? (
                      <button
                        type="button"
                        data-testid="card-retry"
                        className="vn-btn sm"
                        onClick={() => onRerun(v)}
                      >
                        重试
                      </button>
                    ) : v.status === "pending-confirm" ? (
                      <button
                        type="button"
                        data-testid="card-confirm-topics"
                        className="vn-btn sm"
                        onClick={() => onOpenVideo(v, "topics")}
                      >
                        确认主题
                      </button>
                    ) : v.status === "done" ? (
                      <button
                        type="button"
                        data-testid="card-open-notes"
                        className="vn-btn sm"
                        onClick={() => onOpenVideo(v, "notes")}
                      >
                        查看笔记切片
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid="card-continue"
                        className="vn-btn sm"
                        onClick={() => onOpenVideo(v, "topics")}
                      >
                        继续编辑
                      </button>
                    )}
                      <button
                        type="button"
                        data-testid="video-delete"
                        className="vn-btn sm"
                        onClick={() => setDeleting(v)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  {v.status === "failed" && v.failure !== null ? (
                    <p className="vn-hint" data-testid="video-failure" style={{ marginTop: 6 }}>
                      {v.failure}
                    </p>
                  ) : null}
                  {running !== null && running.state === "running" && percent > 0 ? (
                    <ProgressBar percent={percent} />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {deleting !== null ? createPortal(
        <div
          className="vn-mask"
          role="dialog"
          aria-modal="true"
          aria-label="确认删除视频"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleteBusy) setDeleting(null);
          }}
        >
          <div className="vn-modal">
            <h2>确认删除</h2>
            <p>
              确认删除《{deleting.title}》？将同时删除该视频的字幕、主题、笔记及切片文件，原视频文件不受影响。
            </p>
            <div
              className="vn-row"
              style={{ justifyContent: "flex-end", marginTop: 18 }}
            >
              <button
                type="button"
                className="vn-btn"
                disabled={deleteBusy}
                onClick={() => setDeleting(null)}
              >
                取消
              </button>
              <button
                type="button"
                data-testid="delete-confirm"
                className="vn-btn danger"
                disabled={deleteBusy}
                onClick={confirmDelete}
              >
                {deleteBusy ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
