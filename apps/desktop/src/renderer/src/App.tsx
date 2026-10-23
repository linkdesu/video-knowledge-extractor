import { useCallback, useEffect, useRef, useState } from "react";
import type {
  JobSnapshot,
  LibraryVideo,
  VideoDetail,
} from "../../shared/ipc";
import { AppFrame } from "./rbp/blocks/app-shell-1";
import { JobProgress } from "./rbp/blocks/monitoring-9";
import { VideoWorkspace } from "./pages/VideoWorkspace";
import { LibraryPage } from "./pages/LibraryPage";
import { GlossaryPage } from "./pages/GlossaryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ToastHost, showToast } from "./lib/toast";
import { errMessage } from "./lib/format";

// ADR-0014 §2：路由是可判别联合，存在 App 的 state 里，不引路由库。
type Route =
  | { name: "library" }
  | { name: "video"; videoId: string; page: "transcript" | "topics" | "notes" }
  | { name: "glossary" }
  | { name: "settings" };

const PAGE_LABEL: Record<"transcript" | "topics" | "notes", string> = {
  transcript: "字幕",
  topics: "主题",
  notes: "笔记",
};

export function App() {
  const [route, setRoute] = useState<Route>({ name: "library" });
  const [videos, setVideos] = useState<LibraryVideo[] | null>(null);
  const [libError, setLibError] = useState<string | null>(null);
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const routeRef = useRef(route);
  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  const refreshLibrary = useCallback(() => {
    setLibError(null);
    window.vnote
      .listLibrary()
      .then(setVideos)
      .catch((err) => setLibError(errMessage(err)));
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
    // 生成中每个主题的 startedAt 由 core 落盘；运行中的进度事件按 1s 节流刷新详情，
    // 让主题列表的「生成中 · 已用 mm:ss」跟着动，而不是等任务结束才更新。
    let lastLiveRefresh = 0;
    off = window.vnote.onJob((j) => {
      setJob(j);
      const r = routeRef.current;
      if (j.state === "running" && r.name === "video" && r.videoId === j.videoId) {
        const now = Date.now();
        if (now - lastLiveRefresh >= 1000) {
          lastLiveRefresh = now;
          window.vnote
            .getVideo(j.videoId)
            .then(setDetail)
            .catch(() => undefined);
        }
      }
      if (j.state === "succeeded" || j.state === "failed" || j.state === "cancelled") {
        void refreshLibrary();
        const r = routeRef.current;
        if (r.name === "video" && r.videoId === j.videoId) {
          window.vnote
            .getVideo(r.videoId)
            .then(setDetail)
            .catch(() => undefined);
        }
      }
    });
    return () => {
      off?.();
    };
  }, [refreshLibrary]);

  const importVideo = useCallback(() => {
    window.vnote
      .pickVideo()
      .then((sourcePath) => {
        if (sourcePath !== null) {
          window.vnote.startExtract({ kind: "new", sourcePath });
        }
      })
      .catch((err) => showToast(`导入失败：${errMessage(err)}`));
  }, []);

  const importPath = useCallback(
    (path: string) => {
      window.vnote
        .startExtract({ kind: "new", sourcePath: path })
        .catch((err) => showToast(`导入失败：${errMessage(err)}`));
    },
    [],
  );

  const refreshDetail = useCallback((videoId: string) => {
    window.vnote
      .getVideo(videoId)
      .then(setDetail)
      .catch((err) => showToast(`刷新视频失败：${errMessage(err)}`));
  }, []);

  // 打开视频：进入目标页；详情在此拉取。
  const openVideo = useCallback(
    (videoId: string, page: "transcript" | "topics" | "notes") => {
      setRoute({ name: "video", videoId, page });
      setDetail(null);
      window.vnote
        .getVideo(videoId)
        .then(setDetail)
        .catch((err) => {
          showToast(`打开视频失败：${errMessage(err)}`);
          setRoute({ name: "library" });
        });
    },
    [],
  );

  // 旧目录没有记录源路径，重跑前必须让用户重新选择。
  const rerun = useCallback(
    (video: LibraryVideo) => {
      const run = (sourcePath: string) =>
        window.vnote
          .startExtract({ kind: "existing", videoId: video.id, sourcePath })
          .catch((err) => showToast(`重跑失败：${errMessage(err)}`));
      if (video.sourcePath === null) {
        window.vnote.pickVideo().then((sourcePath) => {
          if (sourcePath !== null) void run(sourcePath);
        });
      } else {
        void run(video.sourcePath);
      }
    },
    [],
  );

  const rebuild = useCallback((videoId: string) => {
    window.vnote
      .rebuildTopics(videoId)
      .catch((err) => showToast(`重跑失败：${errMessage(err)}`));
  }, []);

  const cancelJob = useCallback(() => {
    if (job === null) return;
    window.vnote
      .cancelExtract(job.jobId)
      .catch((err) => showToast(`取消失败：${errMessage(err)}`));
  }, [job]);

  const startNotes = useCallback(
    (topicIds: string[]) => {
      if (detail === null) return;
      window.vnote
        .startNotes(detail.video.id, topicIds)
        .catch((err) => showToast(`生成笔记失败：${errMessage(err)}`));
    },
    [detail],
  );

  const toLibrary = useCallback(() => setRoute({ name: "library" }), []);

  // ADR-0014 §2：面包屑只按路由层级推导。顶级页面（视频库 / 术语表 / 设置）只有自身一段；
  // 视频内三页是「视频库 / 标题 / 页名」，首段可点返回视频库。
  const navKey =
    route.name === "glossary"
      ? "glossary"
      : route.name === "settings"
        ? "settings"
        : "library";
  const activeVideo =
    route.name === "video" ? (videos?.find((v) => v.id === route.videoId) ?? null) : null;
  const videoTitle =
    route.name === "video"
      ? (detail !== null && detail.video.id === route.videoId
          ? detail.video.title
          : activeVideo?.title ?? "视频")
      : "";

  const crumb =
    route.name === "library"
      ? { parts: ["视频库"] }
      : route.name === "glossary"
        ? { parts: ["术语表"] }
        : route.name === "settings"
          ? { parts: ["设置"] }
          : {
              parts: ["视频库", videoTitle, PAGE_LABEL[route.page]],
              onBack: toLibrary,
            };

  return (
    <>
      <div aria-hidden="true" className="vn-aurora">
        <i />
        <i />
        <i />
      </div>
      <AppFrame
        active={navKey}
        onNavigate={(key) => {
          if (key === "glossary") setRoute({ name: "glossary" });
          else if (key === "settings") setRoute({ name: "settings" });
          else toLibrary();
        }}
        crumb={crumb}
      >
        {route.name === "video" ? (
          <VideoWorkspace
            key={route.videoId}
            detail={detail}
            page={route.page}
            job={job}
            onPage={(page: "transcript" | "topics" | "notes") =>
              setRoute({ name: "video", videoId: route.videoId, page })
            }
            onBack={toLibrary}
            onRefresh={() => refreshDetail(route.videoId)}
            onStartNotes={startNotes}
            onRebuildTopics={() => rebuild(route.videoId)}
          />
        ) : route.name === "library" ? (
          <LibraryPage
            videos={videos ?? []}
            job={job}
            loading={videos === null && libError === null}
            loadError={libError}
            onReload={() => void refreshLibrary()}
            onOpenVideo={(v, page) => openVideo(v.id, page)}
            onImport={() => void importVideo()}
            onImportPath={(path) => void importPath(path)}
            onRebuild={(id) => void rebuild(id)}
            onRerun={(v) => void rerun(v)}
          />
        ) : route.name === "glossary" ? (
          <GlossaryPage />
        ) : (
          <SettingsPage />
        )}
      </AppFrame>

      {job !== null ? (
        <JobProgress
          job={job}
          onCancel={() => void cancelJob()}
          onClose={() => setJob(null)}
        />
      ) : null}
      <ToastHost />
    </>
  );
}
