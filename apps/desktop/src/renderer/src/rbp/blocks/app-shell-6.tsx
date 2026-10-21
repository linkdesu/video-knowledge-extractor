"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeftIcon,
  FolderOpenIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import type { ClipInfo, LibraryVideo, VideoDetail, VideoTopic } from "../../../../shared/ipc";
import { NoteView } from "../../components/NoteView";
import { CorrectionsEditor } from "../../components/CorrectionsEditor";
import { cn } from "../../lib/utils";

type Props = {
  video: LibraryVideo;
  busy: boolean;
  onBack: () => void;
  onRerun: (video: LibraryVideo) => void;
  onReveal: () => void;
};

const canvas = "bg-white dark:bg-neutral-950";
const frame =
  "relative flex min-w-0 flex-col overflow-hidden rounded-[var(--rb-r-lg,10px)] border border-neutral-900/10 dark:border-neutral-100/14 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100";
const text1 = "text-neutral-900 dark:text-neutral-100";
const text3 = "text-neutral-900/66 dark:text-neutral-100/66";
const typeHeading = "text-[24px]/[28px] font-[450] tracking-[-0.015em]";
const typeBody = "text-[14px]/[20px] font-normal";
const typeBodySm = "text-[13px]/[18px] font-normal";
const typeLabel = "text-[14px]/[16px] font-[450]";
const ghostButton =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap select-none transition-[color,background-color,border-color,box-shadow,outline-color,scale,filter] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.98] active:duration-[60ms] motion-reduce:active:scale-100 disabled:cursor-not-allowed aria-busy:cursor-progress focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rb-accent,oklch(20.5%_0_0))] dark:focus-visible:outline-[var(--rb-accent,oklch(100%_0_0))] bg-transparent text-neutral-900 hover:not-disabled:bg-neutral-900/5 active:bg-neutral-900/8 aria-pressed:bg-neutral-900/9 disabled:text-neutral-900/40 dark:text-neutral-100 dark:hover:not-disabled:bg-neutral-100/5 dark:active:bg-neutral-100/8 dark:aria-pressed:bg-neutral-100/9 dark:disabled:text-neutral-100/40";
const primaryButton =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap select-none transition-[color,background-color,border-color,box-shadow,outline-color,scale,filter] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.98] active:duration-[60ms] motion-reduce:active:scale-100 disabled:cursor-not-allowed aria-busy:cursor-progress focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rb-accent,oklch(20.5%_0_0))] dark:focus-visible:outline-[var(--rb-accent,oklch(100%_0_0))] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--rb-accent,oklch(20.5%_0_0))_84%,white),color-mix(in_oklab,var(--rb-accent,oklch(20.5%_0_0))_94%,black))] text-[var(--rb-accent-fg,oklch(100%_0_0))] shadow-[inset_0_2px_0_-1px_rgb(255_255_255/0.2),inset_0_-2px_0_-1px_rgb(0_0_0/0.3),inset_0_0_0_1px_color-mix(in_oklab,var(--rb-accent,oklch(20.5%_0_0))_88%,black),0_1px_1px_rgb(0_0_0/0.22),0_2px_5px_-2px_rgb(0_0_0/0.3)] hover:not-disabled:brightness-110 active:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--rb-accent,oklch(20.5%_0_0))_88%,black),inset_0_1px_2px_rgb(0_0_0/0.42)] disabled:opacity-40 disabled:shadow-none dark:bg-[linear-gradient(180deg,color-mix(in_oklab,var(--rb-accent,oklch(100%_0_0))_84%,white),color-mix(in_oklab,var(--rb-accent,oklch(100%_0_0))_94%,black))] dark:text-[var(--rb-accent-fg,oklch(20.5%_0_0))] dark:shadow-[inset_0_2px_0_-1px_rgb(255_255_255/0.2),inset_0_-2px_0_-1px_rgb(0_0_0/0.3),inset_0_0_0_1px_color-mix(in_oklab,var(--rb-accent,oklch(100%_0_0))_88%,black),0_1px_1px_rgb(0_0_0/0.66),0_2px_5px_-2px_rgb(0_0_0/0.9)] dark:active:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--rb-accent,oklch(100%_0_0))_88%,black),inset_0_1px_2px_rgb(0_0_0/0.42)] dark:disabled:shadow-none";
const buttonMd =
  "h-8 gap-2 rounded-[var(--rb-r-sm,6px)] px-4 text-[14px]/[16px] font-[450]";
const iconButtonMd = "size-8 rounded-[var(--rb-r-sm,6px)]";
const itemMeta =
  "shrink-0 text-[13px]/[18px] tabular-nums text-neutral-900/66 dark:text-neutral-100/66";
const sidebarSurface =
  "border-r border-neutral-900/8 bg-white dark:border-neutral-100/8 dark:bg-neutral-900";
const navItem =
  "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-[var(--rb-r-sm,6px)] px-2 text-left text-[14px]/[16px] font-[450] text-neutral-900/80 transition-[background-color,color] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] [&_svg]:shrink-0 hover:bg-neutral-900/5 hover:text-neutral-900 aria-[current=page]:bg-neutral-900/9 aria-[current=page]:text-neutral-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--rb-accent,oklch(20.5%_0_0))] dark:focus-visible:outline-[var(--rb-accent,oklch(100%_0_0))] dark:text-neutral-100/80 dark:hover:bg-neutral-100/5 dark:hover:text-neutral-100 dark:aria-[current=page]:bg-neutral-100/9 dark:aria-[current=page]:text-neutral-100";
const fadeTopOnPaper =
  "bg-linear-to-b from-white to-transparent transition-opacity duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] dark:from-neutral-900";
const fadeBottomOnPaper =
  "bg-linear-to-t from-white to-transparent transition-opacity duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] dark:from-neutral-900";

function useScrollFade<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    setEdges({
      start: scrollTop > 1,
      end: Math.ceil(scrollTop + clientHeight) < scrollHeight - 1,
    });
  }, []);

  useEffect(() => {
    update();
    const el = ref.current;
    const view = el?.ownerDocument.defaultView;
    if (!el || !view?.ResizeObserver) return;
    const observer = new view.ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [update]);

  return { ref, edges, onScroll: update };
}

function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function TopicTree({
  topics,
  selectedId,
  onSelect,
}: {
  topics: VideoTopic[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav
      aria-label="主题"
      className="min-h-0 flex-1 overflow-y-auto p-2"
    >
      <ul className="flex flex-col gap-0.5">
        <li>
          <button
            type="button"
            aria-current={selectedId === "index" ? "page" : undefined}
            onClick={() => onSelect("index")}
            className={navItem}
            data-testid="topic-item"
          >
            总览
          </button>
        </li>
        {topics.map((t) => (
          <li key={t.dirName}>
            <button
              type="button"
              aria-current={selectedId === t.dirName ? "page" : undefined}
              onClick={() => onSelect(t.dirName)}
              className={navItem}
              data-testid="topic-item"
            >
              <span className="truncate">{t.title}</span>
            </button>
          </li>
        ))}
        {topics.length === 0 && (
          <li>
            <span className={cn(typeBodySm, text3, "px-2 py-1")}>还没有主题</span>
          </li>
        )}
      </ul>
    </nav>
  );
}

// 视频详情工作区：左「主题」文件树、中「笔记正文」、右「切片与播放器」。
export default function AppShell6({ video, busy, onBack, onRerun, onReveal }: Props) {
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [selected, setSelected] = useState<string>("index");
  const [playing, setPlaying] = useState<ClipInfo | null>(null);
  const {
    ref: noteRef,
    edges: noteEdges,
    onScroll: onNoteScroll,
  } = useScrollFade<HTMLDivElement>();

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
      const topics = detail?.topics ?? [];
      const dirPart = parts.length > 1 ? parts[0] : null;
      const dirName = dirPart !== null ? dirPart : selected === "index" ? null : selected;
      if (dirName === null) return;
      const target = topics.find((t) => t.dirName === dirName);
      if (target === undefined) return;
      if (file.endsWith(".mp4")) {
        const clip = target.clips.find((c) => c.file === file);
        if (clip !== undefined) {
          setSelected(target.dirName);
          setPlaying(clip);
        }
        return;
      }
      if (file === "topic.md") {
        setSelected(target.dirName);
        setPlaying(null);
      }
    },
    [detail, selected],
  );

  const topic =
    selected === "index"
      ? null
      : detail?.topics.find((t) => t.dirName === selected) ?? null;
  const clips: ClipInfo[] = topic === null ? [] : topic.clips;

  const selectTopic = (id: string) => {
    setSelected(id);
    setPlaying(null);
  };
  return (
    <div
      className={cn(
        canvas,
        text1,
        "relative flex h-full min-h-0 w-full overflow-hidden",
      )}
    >
      {/* 左栏：主题文件树 */}
      <aside className={cn(sidebarSurface, "flex w-64 shrink-0 flex-col")}>
        <div className="flex h-12 shrink-0 items-center px-4">
          <span className={typeLabel}>主题</span>
        </div>
        <TopicTree topics={detail?.topics ?? []} selectedId={selected} onSelect={selectTopic} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col p-2">
        <div className={cn(frame, "min-h-0 flex-1")}>
          {/* 顶部操作栏 */}
          <header className="flex h-14 shrink-0 items-center gap-2 px-4 sm:px-6">
            <button
              type="button"
              onClick={onBack}
              className={cn(ghostButton, iconButtonMd)}
              aria-label="返回库"
              data-testid="back-button"
            >
              <HugeiconsIcon
                icon={ArrowLeftIcon}
                size={16}
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className={cn(typeHeading, "truncate")} title={video.title}>
                {video.title}
              </h1>
              <p className={cn(itemMeta, "mt-0.5")}>
                {video.topicCount} 个主题 · {video.clipCount} 个切片
              </p>
            </div>
            <button
              type="button"
              onClick={onReveal}
              className={cn(ghostButton, buttonMd, "max-md:hidden")}
              data-testid="reveal-button"
            >
              <HugeiconsIcon
                icon={FolderOpenIcon}
                size={16}
                strokeWidth={1.8}
                aria-hidden="true"
              />
              在 Finder 中显示
            </button>
            <button
              type="button"
              onClick={() => onRerun(video)}
              disabled={busy}
              className={cn(primaryButton, buttonMd)}
              data-testid="video-rerun"
            >
              <HugeiconsIcon
                icon={RefreshIcon}
                size={16}
                strokeWidth={1.8}
                aria-hidden="true"
              />
              重跑
            </button>
          </header>

          {loadError !== null && (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
              <p className={cn(typeBody, text3)}>加载失败：{loadError}</p>
              <button
                type="button"
                className={cn(ghostButton, buttonMd)}
                onClick={() => setRetryKey((k) => k + 1)}
              >
                重试
              </button>
            </div>
          )}
          {detail === null && loadError === null && (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <p className={cn(typeBody, text3)}>加载中…</p>
            </div>
          )}

          {detail !== null && (
            <div className="flex min-h-0 flex-1">
              {/* 中栏：笔记正文 */}
              <main className="relative min-w-0 flex-1 overflow-hidden">
                <div
                  ref={noteRef}
                  onScroll={onNoteScroll}
                  className="h-full min-h-0 overflow-y-auto"
                >
                  <article className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
                    <div data-testid="note-body">
                      <NoteView
                        markdown={topic === null ? detail.indexMarkdown : topic.markdown}
                        onOpenLink={openLink}
                      />
                    </div>
                    <CorrectionsEditor
                      videoId={video.id}
                      initial={detail.corrections}
                      busy={busy}
                      onRerun={() => onRerun(video)}
                    />
                  </article>
                </div>
                <div
                  aria-hidden="true"
                  className={cn(
                    fadeTopOnPaper,
                    "pointer-events-none absolute inset-x-0 top-0 h-8",
                    noteEdges.start ? "opacity-100" : "opacity-0",
                  )}
                />
                <div
                  aria-hidden="true"
                  className={cn(
                    fadeBottomOnPaper,
                    "pointer-events-none absolute inset-x-0 bottom-0 h-8",
                    noteEdges.end ? "opacity-100" : "opacity-0",
                  )}
                />
              </main>

              {/* 右栏：切片与播放器 */}
              <aside
                className="flex w-[360px] shrink-0 flex-col border-l border-neutral-900/8 bg-white dark:border-neutral-100/8 dark:bg-neutral-900"
              >
                <div className="flex h-12 shrink-0 items-center px-4">
                  <span className={typeLabel}>{topic === null ? "切片" : "切片与播放器"}</span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {topic === null ? (
                    <p className={cn(typeBodySm, text3, "px-2 py-2")}>
                      选择一个主题查看切片
                    </p>
                  ) : clips.length === 0 ? (
                    <p className={cn(typeBodySm, text3, "px-2 py-2")}>
                      这个主题还没有切片
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {clips.map((c) => (
                        <li key={c.file}>
                          <button
                            type="button"
                            onClick={() => setPlaying(c)}
                            aria-pressed={playing?.file === c.file}
                            className={cn(
                              navItem,
                              "h-auto flex-col items-start gap-0.5 py-2",
                              playing?.file === c.file
                                ? "bg-neutral-900/9 text-neutral-900 dark:bg-neutral-100/9 dark:text-neutral-100"
                                : undefined,
                            )}
                            data-testid="clip-item"
                          >
                            <span className="w-full truncate text-left">
                              {c.file}
                            </span>
                            <span className={itemMeta}>
                              {fmtTime(c.startSeconds)} – {fmtTime(c.endSeconds)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="shrink-0 border-t border-neutral-900/8 p-3 dark:border-neutral-100/8">
                  {playing === null || !clips.some((c) => c.file === playing.file) ? (
                    <p className={cn(typeBodySm, text3)}>选择一个切片来播放</p>
                  ) : (
                    <>
                      <video
                        key={playing.mediaUrl}
                        src={playing.mediaUrl}
                        controls
                        autoPlay
                        className="w-full rounded-[var(--rb-r-sm,6px) bg-black"
                        data-testid="clip-player"
                      />
                      <div className={cn(itemMeta, "mt-2 flex items-center justify-between gap-2")}>
                        <span className="truncate font-[450] text-neutral-900 dark:text-neutral-100">
                          {playing.file}
                        </span>
                        <span>
                          {fmtTime(playing.startSeconds)} – {fmtTime(playing.endSeconds)}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </aside>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
