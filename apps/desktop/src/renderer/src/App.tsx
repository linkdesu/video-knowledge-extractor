import { useCallback, useEffect, useState } from "react";
import type { JobSnapshot, LibraryVideo } from "../../shared/ipc";
import { JobBanner } from "./components/JobBanner";
import { SettingsPanel } from "./components/SettingsPanel";
import { LibraryView } from "./views/LibraryView";
import { VideoView } from "./views/VideoView";

export function App() {
  const [videos, setVideos] = useState<LibraryVideo[] | null>(null);
  const [libError, setLibError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [flashError, setFlashError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refreshLibrary = useCallback(async () => {
    setLibError(null);
    try {
      setVideos(await window.vnote.listLibrary());
    } catch (err) {
      setLibError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  // 启动时接管已经在跑的任务，之后全部由 onJob 事件驱动。
  useEffect(() => {
    let off: (() => void) | undefined;
    window.vnote.activeJob().then((j) => {
      if (j !== null) setJob(j);
    });
    off = window.vnote.onJob((j) => {
      setJob(j);
      if (j.state === "succeeded") void refreshLibrary();
    });
    return () => {
      off?.();
    };
  }, [refreshLibrary]);

  const openVideo = useCallback((v: LibraryVideo) => setOpenId(v.id), []);

  const importVideo = useCallback(async () => {
    setFlashError(null);
    try {
      const sourcePath = await window.vnote.pickVideo();
      if (sourcePath === null) return;
      await window.vnote.startExtract({ kind: "new", sourcePath });
    } catch (err) {
      setFlashError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 旧目录没有记录源路径，重跑前必须让用户重新选择。
  const rerun = useCallback(async (v: LibraryVideo) => {
    setFlashError(null);
    try {
      if (v.sourcePath === null) {
        const sourcePath = await window.vnote.pickSource(v.id);
        if (sourcePath === null) return;
        await window.vnote.startExtract({ kind: "existing", videoId: v.id, sourcePath });
      } else {
        await window.vnote.startExtract({ kind: "existing", videoId: v.id });
      }
    } catch (err) {
      setFlashError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const cancelJob = useCallback(async () => {
    if (job === null) return;
    try {
      await window.vnote.cancelExtract(job.jobId);
    } catch (err) {
      setFlashError(err instanceof Error ? err.message : String(err));
    }
  }, [job]);

  const busy = job !== null && (job.state === "queued" || job.state === "running");
  const selected = openId === null ? null : videos?.find((v) => v.id === openId) ?? null;

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__brand">video-notes</h1>
        {selected !== null && (
          <button
            type="button"
            className="app__back"
            onClick={() => setOpenId(null)}
          >
            ← 返回库
          </button>
        )}
        <div className="app__header-actions">
          <button type="button" className="btn" onClick={() => setSettingsOpen(true)}>
            设置
          </button>
        </div>
      </header>

      {job !== null && (
        <JobBanner job={job} onCancel={() => void cancelJob()} onClose={() => setJob(null)} />
      )}

      {flashError !== null && (
        <div className="flash-error">
          {flashError}
          <button type="button" className="flash-error__close" onClick={() => setFlashError(null)} aria-label="关闭">
            ×
          </button>
        </div>
      )}

      {selected === null &&
        (videos === null && libError === null ? (
          <div className="statebox">加载库中…</div>
        ) : libError !== null ? (
          <div className="statebox statebox--error">
            加载库失败：{libError}
            <button type="button" className="btn" onClick={() => void refreshLibrary()}>
              重试
            </button>
          </div>
        ) : (
          <LibraryView
            videos={videos ?? []}
            busy={busy}
            onOpen={openVideo}
            onImport={() => void importVideo()}
            onRerun={(v) => void rerun(v)}
          />
        ))}

      {selected !== null && (
        <VideoView
          key={selected.id}
          video={selected}
          busy={busy}
          onBack={() => setOpenId(null)}
          onRerun={(v) => void rerun(v)}
          onReveal={() => void window.vnote.reveal(selected.outputDir)}
        />
      )}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
