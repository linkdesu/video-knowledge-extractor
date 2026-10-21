import { useCallback, useEffect, useState } from "react";
import type { ClipInfo, LibraryVideo, VideoDetail, VideoId } from "../../../shared/ipc";
import { CorrectionsEditor } from "../components/CorrectionsEditor";
import { NoteView } from "../components/NoteView";

type Props = {
  video: LibraryVideo;
  busy: boolean;
  onBack: () => void;
  onRerun: (video: LibraryVideo) => void;
  onReveal: () => void;
};

export function VideoView({ video, busy, onBack, onRerun, onReveal }: Props) {
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [selected, setSelected] = useState<VideoId | "index">("index");
  const [playing, setPlaying] = useState<ClipInfo | null>(null);

  // 提取完成或外部刷新时重新拉取详情：video 引用变化即重取。
  useEffect(() => {
    let active = true;
    setLoadError(null);
    window.vnote
      .getVideo(video.id)
      .then((d) => {
        if (!active) return;
        setDetail(d);
      })
      .catch((err) => {
        if (active) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [video, retryKey]);

  // markdown 链接形如 `./<主题目录>/topic.md` 或 `./<主题目录>/<切片>.mp4`，也可能是当前主题内的裸文件名。
  const openLink = useCallback(
    (href: string) => {
      const parts = decodeURIComponent(href)
        .split("/")
        .filter((part) => part !== "" && part !== "." && part !== "..");
      const file = parts.at(-1);
      if (file === undefined) return;
      const topicDir = parts.length > 1 ? parts[0] : selected === "index" ? null : selected;
      if (topicDir === null || topicDir === undefined) return;
      if (file.endsWith(".mp4")) {
        const target = detail?.topics.find((t) => t.dirName === topicDir);
        const clip = target?.clips.find((c) => c.file === file);
        if (clip !== undefined) {
          setSelected(topicDir);
          setPlaying(clip);
        }
        return;
      }
      if (file === "topic.md" && topicDir !== null && detail?.topics.some((t) => t.dirName === topicDir) === true) {
        setSelected(topicDir);
        setPlaying(null);
      }
    },
    [detail, selected],
  );

  const topic = selected === "index" ? null : detail?.topics.find((t) => t.dirName === selected) ?? null;
  const clips: ClipInfo[] = topic === null ? [] : topic.clips;

  return (
    <div className="video-view">
      <header className="video-view__header">
        <button type="button" className="btn" onClick={onBack}>
          ← 返回库
        </button>
        <h2 className="video-view__title">{video.title}</h2>
        <span className="video-view__meta">
          {video.topicCount} 个主题 · {video.clipCount} 个切片
        </span>
        <div className="video-view__actions">
          <button type="button" className="btn" onClick={onReveal}>
            在 Finder 中显示
          </button>
          <button type="button" className="btn btn--primary" onClick={() => onRerun(video)} disabled={busy}>
            重跑
          </button>
        </div>
      </header>

      {loadError !== null && (
        <div className="statebox statebox--error">
          加载失败：{loadError}
          <button type="button" className="btn" onClick={() => setRetryKey((k) => k + 1)}>
            重试
          </button>
        </div>
      )}
      {detail === null && loadError === null && <div className="statebox">加载中…</div>}

      {detail !== null && (
        <div className="video-view__body">
          <nav className="topic-list">
            <button
              type="button"
              className={`topic-list__item ${selected === "index" ? "topic-list__item--active" : ""}`}
              onClick={() => {
                setSelected("index");
                setPlaying(null);
              }}
            >
              总览
            </button>
            {detail.topics.map((t) => (
              <button
                type="button"
                key={t.dirName}
                className={`topic-list__item ${selected === t.dirName ? "topic-list__item--active" : ""}`}
                onClick={() => {
                  setSelected(t.dirName);
                  setPlaying(null);
                }}
              >
                {t.title}
              </button>
            ))}
            {detail.topics.length === 0 && <div className="topic-list__empty">还没有主题</div>}
          </nav>

          <main className="video-view__main">
            <NoteView
              markdown={topic === null ? detail.indexMarkdown : topic.markdown}
              onOpenLink={openLink}
            />
            {topic !== null && (
              <div className="clip-list">
                <h3>切片</h3>
                {clips.length === 0 && <div className="clip-list__empty">这个主题还没有切片</div>}
                {clips.map((c) => (
                  <button
                    type="button"
                    key={c.file}
                    className={`clip-list__item ${playing?.file === c.file ? "clip-list__item--active" : ""}`}
                    onClick={() => setPlaying(c)}
                  >
                    {c.file}
                  </button>
                ))}
              </div>
            )}
            <CorrectionsEditor
              videoId={video.id}
              initial={detail.corrections}
              busy={busy}
              onRerun={() => onRerun(video)}
            />
          </main>

          <aside className="video-view__player">
            {playing === null ? (
              <div className="player__empty">选择一个切片来播放</div>
            ) : (
              <>
                <video key={playing.mediaUrl} className="player__video" src={playing.mediaUrl} controls autoPlay />
                <div className="player__meta">
                  {playing.file}
                  <span>
                    {fmtTime(playing.startSeconds)} – {fmtTime(playing.endSeconds)}
                  </span>
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
