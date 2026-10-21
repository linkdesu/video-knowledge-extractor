import { useCallback, useEffect, useState } from "react";
import type { JobSnapshot, LibraryVideo } from "../../shared/ipc";
import { SettingsPanel } from "./components/SettingsPanel";
import { AppShell1 } from "./rbp/blocks/app-shell-1";
import AppShell6 from "./rbp/blocks/app-shell-6";
import { JobProgress } from "./rbp/blocks/monitoring-9";

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

  // 拖拽导入：路径已由 renderer 侧取好，这里只负责发起任务。
  const importPath = useCallback(
    async (path: string) => {
      setFlashError(null);
      try {
        await window.vnote.startExtract({ kind: "new", sourcePath: path });
      } catch (err) {
        setFlashError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

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

  const libraryScreen =
    videos === null && libError === null ? (
      <div className="flex h-full items-center justify-center">
        <div className="border border-dashed border-neutral-900/12 px-8 py-6 text-[14px]/[20px] text-neutral-900/80 dark:border-neutral-100/12 dark:text-neutral-100/80">
          加载库中…
        </div>
      </div>
    ) : libError !== null ? (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 border border-dashed border-neutral-900/12 px-8 py-6 text-[14px]/[20px] text-neutral-900/80 dark:border-neutral-100/12 dark:text-neutral-100/80">
          <span>加载库失败：{libError}</span>
          <button
            type="button"
            onClick={() => void refreshLibrary()}
            className="cursor-pointer rounded-[var(--rb-r-sm,6px)] border border-neutral-900/12 px-4 py-1.5 text-[13px]/[18px] text-neutral-900 hover:bg-neutral-900/5 dark:border-neutral-100/12 dark:text-neutral-100 dark:hover:bg-neutral-100/5"
          >
            重试
          </button>
        </div>
      </div>
    ) : (
      <div className="h-full w-full" data-testid="library">
        <AppShell1
          videos={videos ?? []}
          busy={busy}
          onOpen={openVideo}
          onImport={() => void importVideo()}
          onImportPath={(path) => void importPath(path)}
          onRerun={(v) => void rerun(v)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      {selected === null ? (
        libraryScreen
      ) : (
        <div key={selected.id} className="h-full min-h-0 flex-1" data-testid="video-view">
          <AppShell6
            video={selected}
            busy={busy}
            onBack={() => setOpenId(null)}
            onRerun={(v) => void rerun(v)}
            onReveal={() => void window.vnote.reveal(selected.outputDir)}
          />
        </div>
      )}

      {job !== null && (
        <JobProgress job={job} onCancel={() => void cancelJob()} onClose={() => setJob(null)} />
      )}

      {flashError !== null && (
        <div
          role="alert"
          className="fixed bottom-4 left-4 z-40 flex max-w-[min(28rem,calc(100vw-2rem))] items-start gap-3 rounded-[var(--rb-r-lg,10px)] border border-neutral-900/10 bg-neutral-50 px-4 py-3 text-[13px]/[18px] text-neutral-900 shadow-[0_12px_32px_-8px_rgb(0_0_0/0.55)] dark:border-neutral-100/14 dark:bg-neutral-900 dark:text-neutral-100"
        >
          <span className="min-w-0 flex-1">{flashError}</span>
          <button
            type="button"
            onClick={() => setFlashError(null)}
            aria-label="关闭"
            className="shrink-0 cursor-pointer text-neutral-900/66 hover:text-neutral-900 dark:text-neutral-100/66 dark:hover:text-neutral-100"
          >
            ×
          </button>
        </div>
      )}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
