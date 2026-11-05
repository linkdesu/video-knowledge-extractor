import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { ProjectClipInfo, ProjectDetail } from "../../../shared/ipc";
import {
  clipMetaLine,
  clipPlayerSubtitle,
  clipStatsLine,
  clipThumbLabel,
  clipTimeLabel,
  clipsNewestFirst,
} from "../lib/project-clips";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function ClipCard({
  clip,
  onPlay,
}: {
  clip: ProjectClipInfo;
  onPlay: (clip: ProjectClipInfo, trigger: HTMLButtonElement) => void;
}): JSX.Element {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const metaLine = clipMetaLine(clip);

  return (
    <article className="vn-card vn-clip-card" data-testid="clip-card">
      <button
        type="button"
        className="vn-clip-thumb"
        data-testid="clip-thumb"
        aria-label={`播放 ${clip.title}`}
        onClick={(event) => onPlay(clip, event.currentTarget)}
      >
        {thumbnailFailed ? (
          <span className="vn-clip-thumb-placeholder">无法预览此切片</span>
        ) : (
          <video
            className="vn-clip-thumb-video"
            src={clip.mediaUrl}
            preload="metadata"
            muted
            playsInline
            aria-hidden="true"
            tabIndex={-1}
            onLoadedMetadata={(event) => {
              event.currentTarget.currentTime = 0.1;
            }}
            onError={() => setThumbnailFailed(true)}
          />
        )}
        <span className="vn-clip-duration">{clipThumbLabel(clip)}</span>
      </button>
      <div className="vn-clip-body">
        <h3 className="vn-clip-title" data-testid="clip-title">
          {clip.title}
        </h3>
        {metaLine === "" ? null : (
          <p className="vn-clip-meta" data-testid="clip-meta">
            {metaLine}
          </p>
        )}
        <p className="vn-clip-stats" data-testid="clip-stats">
          {clipStatsLine(clip)}
        </p>
        <div className="vn-clip-actions">
          <button
            type="button"
            className="vn-btn sm"
            data-testid="clip-export"
            title="占位，暂无操作"
          >
            导出
          </button>
          <button
            type="button"
            className="vn-btn sm"
            data-testid="clip-upload"
            title="占位，暂无操作"
          >
            上传
          </button>
        </div>
      </div>
    </article>
  );
}

function ClipPlayer({ clip, onClose }: { clip: ProjectClipInfo; onClose: () => void }): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(Math.max(0, clip.durationSeconds));
  const [playing, setPlaying] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);

  const close = useCallback(() => {
    const video = videoRef.current;
    if (video !== null) {
      video.pause();
      video.removeAttribute("src");
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    dialogRef.current?.focus();
    return () => {
      const video = videoRef.current;
      if (video !== null) {
        video.pause();
        video.removeAttribute("src");
      }
    };
  }, []);

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const togglePlayback = () => {
    const video = videoRef.current;
    if (video === null || playbackFailed) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    if (video.ended || (duration > 0 && video.currentTime >= duration)) {
      video.currentTime = 0;
      setCurrentTime(0);
    }
    void video.play().catch(() => setPlaying(false));
  };

  return createPortal(
    <div
      ref={dialogRef}
      className="vn-mask vn-clip-player-mask"
      data-testid="clip-player"
      role="dialog"
      aria-modal="true"
      aria-labelledby="clip-player-title"
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="vn-modal vn-clip-player">
        <div className="vn-clip-player-head">
          <div>
            <h2 id="clip-player-title">{clip.title}</h2>
            <p>{clipPlayerSubtitle(clip)}</p>
          </div>
          <button
            type="button"
            className="vn-btn sm"
            data-testid="player-close"
            aria-label="关闭播放器"
            onClick={close}
          >
            关闭
          </button>
        </div>

        <div className="vn-clip-player-frame">
          {playbackFailed ? (
            <div className="vn-clip-playback-error" role="status">
              无法播放此切片，请确认文件仍然存在且格式受支持。
            </div>
          ) : (
            <video
              ref={videoRef}
              data-testid="player-video"
              src={clip.mediaUrl}
              preload="metadata"
              playsInline
              onLoadedMetadata={(event) => {
                const nextDuration = event.currentTarget.duration;
                if (Number.isFinite(nextDuration) && nextDuration >= 0) setDuration(nextDuration);
              }}
              onDurationChange={(event) => {
                const nextDuration = event.currentTarget.duration;
                if (Number.isFinite(nextDuration) && nextDuration >= 0) setDuration(nextDuration);
              }}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onError={() => setPlaybackFailed(true)}
            />
          )}
        </div>

        <div className="vn-clip-player-controls">
          <button
            type="button"
            className="vn-btn sm"
            data-testid="player-toggle"
            disabled={playbackFailed}
            onClick={togglePlayback}
          >
            {playing ? "暂停" : "播放"}
          </button>
          <input
            className="vn-clip-player-seek"
            data-testid="player-seek"
            type="range"
            aria-label="播放进度"
            min={0}
            max={duration}
            step={0.1}
            value={Math.min(currentTime, duration)}
            disabled={playbackFailed || duration <= 0}
            onChange={(event) => {
              const nextTime = Number(event.target.value);
              if (videoRef.current !== null) videoRef.current.currentTime = nextTime;
              setCurrentTime(nextTime);
            }}
          />
          <span className="vn-clip-player-time" data-testid="player-time">
            {clipTimeLabel(currentTime, duration)}
          </span>
        </div>
        <p className="vn-clip-player-path" data-testid="player-path">
          {clip.path}
        </p>
      </div>
    </div>,
    document.body,
  );
}

export function ProjectClipsTab({
  project,
  onOpenClipsDir,
}: {
  project: ProjectDetail;
  onOpenClipsDir: () => void;
}): JSX.Element {
  const [activeClip, setActiveClip] = useState<ProjectClipInfo | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const openPlayer = (clip: ProjectClipInfo, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setActiveClip(clip);
  };

  const closePlayer = useCallback(() => {
    setActiveClip(null);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  return (
    <div className="vn-clips" data-testid="project-clips-tab">
      <div className="vn-clips-head">
        <div className="vn-clips-heading">
          <h2>切片产出</h2>
          <span className="vn-tag">{project.clips.length} 个</span>
        </div>
        <button
          type="button"
          className="vn-btn sm"
          data-testid="clips-open-dir"
          onClick={onOpenClipsDir}
        >
          打开切片目录
        </button>
      </div>
      <p className="vn-clips-path" data-testid="clips-path">
        {project.clipsDir}
      </p>

      {project.clips.length === 0 ? (
        <div className="vn-clips-empty" data-testid="clips-empty">
          尚无切片；生成后全部存放在此项目目录。
        </div>
      ) : (
        <div className="vn-clips-grid">
          {clipsNewestFirst(project.clips).map((clip) => (
            <ClipCard key={clip.path} clip={clip} onPlay={openPlayer} />
          ))}
        </div>
      )}

      {activeClip === null ? null : (
        <ClipPlayer key={activeClip.path} clip={activeClip} onClose={closePlayer} />
      )}
    </div>
  );
}
