"use client";

import {
  BookOpen01Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { LibraryVideo } from "../../../../shared/ipc";
import { formatUpdated } from "../../lib/format";
import { StatTiles } from "./bento-29";
import EmptyState5 from "./empty-state-5";

const cx = (...c: (string | false | null | undefined)[]) =>
  c.filter(Boolean).join(" ");

const canvas = "bg-white dark:bg-neutral-950";
const brandMark =
  "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--rb-r-sm,6px)] bg-[var(--rb-accent,oklch(20.5%_0_0))] text-[var(--rb-accent-fg,oklch(100%_0_0))] select-none dark:bg-[var(--rb-accent,oklch(100%_0_0))] dark:text-[var(--rb-accent-fg,oklch(20.5%_0_0))]";
const text1 = "text-neutral-900 dark:text-neutral-100";
const text3 = "text-neutral-900/66 dark:text-neutral-100/66";
const typeLabel = "text-[14px]/[16px] font-[450]";
const typeCaption = "text-[12px]/[16px] font-normal tabular-nums";
const ghostButton =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap select-none transition-[color,background-color,border-color,box-shadow,outline-color,scale,filter] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.98] active:duration-[60ms] motion-reduce:active:scale-100 disabled:cursor-not-allowed aria-busy:cursor-progress focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rb-accent,oklch(20.5%_0_0))] dark:focus-visible:outline-[var(--rb-accent,oklch(100%_0_0))] bg-transparent text-neutral-900 hover:not-disabled:bg-neutral-900/5 active:bg-neutral-900/8 aria-pressed:bg-neutral-900/9 disabled:text-neutral-900/40 dark:text-neutral-100 dark:hover:not-disabled:bg-neutral-100/5 dark:active:bg-neutral-100/8 dark:aria-pressed:bg-neutral-100/9 dark:disabled:text-neutral-100/40";
const primaryButton =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap select-none transition-[color,background-color,border-color,box-shadow,outline-color,scale,filter] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.98] active:duration-[60ms] motion-reduce:active:scale-100 disabled:cursor-not-allowed aria-busy:cursor-progress focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rb-accent,oklch(20.5%_0_0))] dark:focus-visible:outline-[var(--rb-accent,oklch(100%_0_0))] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--rb-accent,oklch(20.5%_0_0))_84%,white),color-mix(in_oklab,var(--rb-accent,oklch(20.5%_0_0))_94%,black))] text-[var(--rb-accent-fg,oklch(100%_0_0))] shadow-[inset_0_2px_0_-1px_rgb(255_255_255/0.2),inset_0_-2px_0_-1px_rgb(0_0_0/0.3),inset_0_0_0_1px_color-mix(in_oklab,var(--rb-accent,oklch(20.5%_0_0))_88%,black),0_1px_1px_rgb(0_0_0/0.22),0_2px_5px_-2px_rgb(0_0_0/0.3)] hover:not-disabled:brightness-110 active:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--rb-accent,oklch(20.5%_0_0))_88%,black),inset_0_1px_2px_rgb(0_0_0/0.42)] disabled:opacity-40 disabled:shadow-none dark:bg-[linear-gradient(180deg,color-mix(in_oklab,var(--rb-accent,oklch(100%_0_0))_84%,white),color-mix(in_oklab,var(--rb-accent,oklch(100%_0_0))_94%,black))] dark:text-[var(--rb-accent-fg,oklch(20.5%_0_0))] dark:shadow-[inset_0_2px_0_-1px_rgb(255_255_255/0.2),inset_0_-2px_0_-1px_rgb(0_0_0/0.3),inset_0_0_0_1px_color-mix(in_oklab,var(--rb-accent,oklch(100%_0_0))_88%,black),0_1px_1px_rgb(0_0_0/0.66),0_2px_5px_-2px_rgb(0_0_0/0.9)] dark:active:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--rb-accent,oklch(100%_0_0))_88%,black),inset_0_1px_2px_rgb(0_0_0/0.42)] dark:disabled:shadow-none";
const buttonMd =
  "h-8 gap-2 rounded-[var(--rb-r-sm,6px)] px-4 text-[14px]/[16px] font-[450]";
const buttonLg =
  "h-11 gap-2 rounded-[var(--rb-r-sm,6px)] px-5 text-[16px]/[20px] font-[450] tracking-[-0.01em]";
const frame =
  "relative flex min-w-0 flex-col overflow-hidden rounded-[var(--rb-r-lg,10px)] border border-neutral-900/10 dark:border-neutral-100/14 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100";
const sidebarSurface =
  "border-r border-neutral-900/8 bg-white dark:border-neutral-100/8 dark:bg-neutral-900";
const navItem =
  "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-[var(--rb-r-sm,6px)] px-2 text-left text-[14px]/[16px] font-[450] text-neutral-900/80 transition-[background-color,color] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] [&_svg]:shrink-0 hover:bg-neutral-900/5 hover:text-neutral-900 aria-[current=page]:bg-neutral-900/9 aria-[current=page]:text-neutral-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--rb-accent,oklch(20.5%_0_0))] dark:focus-visible:outline-[var(--rb-accent,oklch(100%_0_0))] dark:text-neutral-100/80 dark:hover:bg-neutral-100/5 dark:hover:text-neutral-100 dark:aria-[current=page]:bg-neutral-100/9 dark:aria-[current=page]:text-neutral-100";

type Props = {
  videos: LibraryVideo[];
  busy: boolean;
  onOpen: (video: LibraryVideo) => void;
  onImport: () => void;
  onImportPath: (path: string) => void;
  onRerun: (video: LibraryVideo) => void;
  onOpenSettings: () => void;
};

export function AppShell1({
  videos,
  busy,
  onOpen,
  onImport,
  onImportPath,
  onRerun,
  onOpenSettings,
}: Props) {
  const topicTotal = videos.reduce((sum, v) => sum + v.topicCount, 0);
  const clipTotal = videos.reduce((sum, v) => sum + v.clipCount, 0);

  return (
    <div className={cx(canvas, text1, "flex h-full w-full overflow-hidden")}>
      <aside className={cx(sidebarSurface, "flex w-64 shrink-0 flex-col")}>
        <div className="flex h-14 shrink-0 items-center gap-2.5 pl-3 pr-2">
          <span aria-hidden="true" className={cx(brandMark, "size-8", typeLabel)}>
            V
          </span>
          <div className="min-w-0 flex-1">
            <p className={cx(typeLabel, "truncate")}>video-notes</p>
            <p className={cx(typeCaption, text3, "truncate")}>视频笔记库</p>
          </div>
        </div>

        <nav
          aria-label="Primary"
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        >
          <ul className="space-y-0.5">
            <li>
              <span aria-current="page" className={navItem}>
                <HugeiconsIcon
                  icon={BookOpen01Icon}
                  size={16}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">库</span>
              </span>
            </li>
            <li>
              <button
                type="button"
                data-testid="open-settings"
                onClick={onOpenSettings}
                className={navItem}
              >
                <HugeiconsIcon
                  icon={Settings01Icon}
                  size={16}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">设置</span>
              </button>
            </li>
          </ul>
        </nav>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col gap-6 p-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h1 className="text-[24px]/[32px] font-[450] tracking-[-0.01em]">
              视频库
            </h1>
            <button
              type="button"
              data-testid="import-button"
              onClick={onImport}
              disabled={busy}
              className={cx(primaryButton, buttonLg)}
            >
              导入视频
            </button>
          </div>

          <div data-testid="library-stats" className="max-w-[720px]">
            <StatTiles
              items={[
                { label: "视频", value: videos.length },
                { label: "主题", value: topicTotal },
                { label: "切片", value: clipTotal },
              ]}
            />
          </div>

          {videos.length === 0 ? (
            <EmptyState5
              onImport={onImport}
              onImportPath={onImportPath}
              busy={busy}
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {videos.map((v) => (
                <article
                  key={v.id}
                  data-testid="video-card"
                  onClick={() => onOpen(v)}
                  className={cx(
                    frame,
                    "cursor-pointer p-4 transition-[background-color] duration-[120ms] hover:bg-neutral-900/5 dark:hover:bg-neutral-100/5",
                  )}
                >
                  <h3 className={cx(typeLabel, "truncate")}>{v.title}</h3>
                  <div
                    className={cx(
                      typeCaption,
                      text3,
                      "mt-2 flex flex-wrap gap-x-3",
                    )}
                  >
                    <span>{v.topicCount} 个主题</span>
                    <span>{v.clipCount} 个切片</span>
                    <span>{formatUpdated(v.updatedAt)}</span>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      data-testid="card-rerun"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRerun(v);
                      }}
                      disabled={busy}
                      className={cx(ghostButton, buttonMd)}
                    >
                      重跑
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
