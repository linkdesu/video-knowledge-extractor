import { useCallback, useEffect, useState } from "react";
import type {
  JobSnapshot,
  LibraryVideo,
  VideoDetail,
  VideoStatus,
} from "../../../shared/ipc";
import DropZone from "../rbp/blocks/empty-state-5";
import { ProgressBar } from "../rbp/blocks/monitoring-9";
import { VideoGlossaryPanel } from "../components/VideoGlossaryPanel";
import { errMessage, fmtBytes, fmtClock } from "../lib/format";
import { showToast } from "../lib/toast";

const STATUS_TAG: Record<VideoStatus, { label: string; cls: string }> = {
  done: { label: "已完成", cls: "vn-tag ok" },
  "in-progress": { label: "处理中", cls: "vn-tag warn" },
  "needs-rerun": { label: "需重跑", cls: "vn-tag warn" },
  failed: { label: "失败", cls: "vn-tag err" },
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

type RerunScope = "topics" | "asr";

export function LibraryPage({
  videos,
  job,
  loading,
  loadError,
  onReload,
  onOpenVideo,
  onImport,
  onImportPath,
  onRebuild,
  onRerun,
}: {
  videos: LibraryVideo[];
  job: JobSnapshot | null;
  loading: boolean;
  loadError: string | null;
  onReload: () => void;
  onOpenVideo: (video: LibraryVideo, page: "topics" | "notes") => void;
  onImport: () => void;
  onImportPath: (path: string) => void;
  onRebuild: (videoId: string) => void;
  onRerun: (video: LibraryVideo) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [rerunScope, setRerunScope] = useState<RerunScope>("topics");
  useEffect(() => {
    if (expandedId === null) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    window.vnote
      .getVideo(expandedId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) setDetailError(errMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [expandedId]);

  const refreshDetail = useCallback(async () => {
    if (expandedId === null) return;
    try {
      const d = await window.vnote.getVideo(expandedId);
      setDetail(d);
      setDetailError(null);
    } catch (err) {
      setDetailError(errMessage(err));
    }
  }, [expandedId]);

  const closeGlossary = useCallback(() => {
    setExpandedId(null);
    setDetail(null);
    setDetailError(null);
  }, []);

  const confirmRerun = () => {
    const video = videos.find((v) => v.id === expandedId);
    setRerunOpen(false);
    if (video === undefined) return;
    if (rerunScope === "topics") {
      onRebuild(video.id);
      showToast("已排队：仅重新生成主题 + 笔记");
    } else {
      onRerun(video);
      showToast("已排队：重新转写 + 主题 + 笔记");
    }
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
              running !== null
                ? running.state === "running" && running.step === "transcribe"
                  ? `转写中 ${Math.round(percent)}%`
                  : `处理中 ${Math.round(percent)}%`
                : STATUS_TAG[v.status].label;
            const cls = running !== null ? "vn-tag warn" : STATUS_TAG[v.status].cls;
            const expanded = expandedId === v.id;
            return (
              <div key={v.id} className="vn-card vn-vcard" data-testid="video-card">
                <div className="vn-thumb">
                  <span className="vn-dur">
                    {v.durationSeconds !== null ? fmtClock(v.durationSeconds) : "—"}
                  </span>
                </div>
                <div className="vn-vbody">
                  <button
                    type="button"
                    className="vn-title"
                    data-testid="video-title"
                    onClick={() => (expanded ? closeGlossary() : setExpandedId(v.id))}
                  >
                    {v.title}
                  </button>
                  <div className="vn-meta">
                    <span>{importLabel(v.importedAt)}</span>
                    <span>{v.sizeBytes !== null ? fmtBytes(v.sizeBytes) : "—"}</span>
                    {v.resolution !== null ? (
                      <span data-testid="video-resolution">
                        {v.resolution.width}×{v.resolution.height}
                      </span>
                    ) : null}
                    {v.topicCount > 0 ? <span>{v.topicCount} 个主题</span> : null}
                  </div>
                  <div className="vn-row vn-between" style={{ marginTop: 12 }}>
                    <span data-testid="video-status" className={cls}>
                      {label}
                    </span>
                    <button
                      type="button"
                      data-testid={v.status === "done" ? "card-open-notes" : "card-continue"}
                      className="vn-btn sm"
                      onClick={() =>
                        onOpenVideo(v, v.status === "done" ? "notes" : "topics")
                      }
                    >
                      {v.status === "done" ? "查看笔记切片" : "继续编辑"}
                    </button>
                  </div>
                  {running ? <ProgressBar percent={percent} /> : null}
                  {expanded ? (
                    <div
                      style={{
                        marginTop: 8,
                        borderTop: "1px solid var(--vn-line)",
                        paddingTop: 8,
                      }}
                    >
                      {detailError !== null ? (
                        <p className="vn-hint">加载本视频术语表失败：{detailError}</p>
                      ) : detail !== null ? (
                        <VideoGlossaryPanel
                          videoId={detail.video.id}
                          entries={detail.corrections}
                          onSaved={refreshDetail}
                        />
                      ) : null}
                      <div className="vn-row" style={{ marginTop: 8 }}>
                        <button
                          type="button"
                          data-testid="rerun-scope-open"
                          className="vn-btn sm"
                          onClick={() => {
                            setRerunScope("topics");
                            setRerunOpen(true);
                          }}
                        >
                          修改后选择重跑范围
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {rerunOpen ? (
        <div
          className="vn-mask"
          role="dialog"
          aria-modal="true"
          aria-label="选择重跑范围"
          onClick={(e) => {
            if (e.target === e.currentTarget) setRerunOpen(false);
          }}
        >
          <div className="vn-modal">
            <h3>选择重跑范围</h3>
            <p>
              受影响的视频：
              {videos.find((v) => v.id === expandedId)?.title ?? ""}。
            </p>
            <div
              className={`vn-radio${rerunScope === "topics" ? " on" : ""}`}
              role="radio"
              aria-checked={rerunScope === "topics"}
              onClick={() => setRerunScope("topics")}
            >
              <div style={{ width: 16 }}>●</div>
              <div>
                <b>仅重新生成主题和笔记</b>
                <span>不重跑 ASR，约 40 秒。</span>
              </div>
            </div>
            <div
              className={`vn-radio${rerunScope === "asr" ? " on" : ""}`}
              role="radio"
              aria-checked={rerunScope === "asr"}
              onClick={() => setRerunScope("asr")}
            >
              <div style={{ width: 16 }}>○</div>
              <div>
                <b>连同语音重新转写</b>
                <span>术语作为 ASR 上下文，字幕、主题、笔记全部更新。</span>
              </div>
            </div>
            <div
              className="vn-row"
              style={{ justifyContent: "flex-end", marginTop: 18 }}
            >
              <button type="button" className="vn-btn" onClick={() => setRerunOpen(false)}>
                取消
              </button>
              <button
                type="button"
                data-testid="rerun-confirm"
                className="vn-btn primary"
                onClick={confirmRerun}
              >
                开始重跑
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
