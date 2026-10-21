"use client";
import { useState, type DragEvent } from "react";
import { Upload04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { LuminousType } from "../react-bits/luminous-type";

const cx = (...c: (string | false | null | undefined)[]) =>
  c.filter(Boolean).join(" ");

const canvas = "bg-white dark:bg-neutral-950";
const selectedFill = "bg-neutral-900/9 dark:bg-neutral-100/9";
const text2 = "text-neutral-900/80 dark:text-neutral-100/80";
const markEdge = "border border-neutral-900/50 dark:border-neutral-100/50";
const dropEdge =
  "border border-dashed border-neutral-900/20 dark:border-neutral-100/20";
const cornerSm = "rounded-[var(--rb-r-sm,6px)]";
const transition =
  "transition-[color,background-color,border-color,box-shadow,outline-color,opacity,scale] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] active:duration-[60ms]";
const panel =
  "relative flex min-w-0 flex-col overflow-hidden rounded-[var(--rb-r-lg,10px)] border border-neutral-900/10 dark:border-neutral-100/14 bg-neutral-50 text-neutral-900 dark:text-neutral-100 dark:bg-neutral-900";
const panelBody =
  "mx-1 mb-1 flex min-w-0 flex-col overflow-hidden rounded-[var(--rb-r-sm,6px)] border border-neutral-900/8 bg-white [&:has(+*)]:mb-0 dark:border-neutral-100/8 dark:bg-neutral-950";
const emptyDescription =
  "max-w-[48ch] text-[13px]/[18px] text-neutral-900/80 dark:text-neutral-100/80";
const primaryButton =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap select-none transition-[color,background-color,border-color,box-shadow,outline-color,scale,filter] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.98] active:duration-[60ms] motion-reduce:active:scale-100 disabled:cursor-not-allowed aria-busy:cursor-progress focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rb-accent,oklch(20.5%_0_0))] dark:focus-visible:outline-[var(--rb-accent,oklch(100%_0_0))] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--rb-accent,oklch(20.5%_0_0))_84%,white),color-mix(in_oklab,var(--rb-accent,oklch(20.5%_0_0))_94%,black))] text-[var(--rb-accent-fg,oklch(100%_0_0))] shadow-[inset_0_2px_0_-1px_rgb(255_255_255/0.2),inset_0_-2px_0_-1px_rgb(0_0_0/0.3),inset_0_0_0_1px_color-mix(in_oklab,var(--rb-accent,oklch(20.5%_0_0))_88%,black),0_1px_1px_rgb(0_0_0/0.22),0_2px_5px_-2px_rgb(0_0_0/0.3)] hover:not-disabled:brightness-110 active:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--rb-accent,oklch(20.5%_0_0))_88%,black),inset_0_1px_2px_rgb(0_0_0/0.42)] disabled:opacity-40 disabled:shadow-none dark:bg-[linear-gradient(180deg,color-mix(in_oklab,var(--rb-accent,oklch(100%_0_0))_84%,white),color-mix(in_oklab,var(--rb-accent,oklch(100%_0_0))_94%,black))] dark:text-[var(--rb-accent-fg,oklch(20.5%_0_0))] dark:shadow-[inset_0_2px_0_-1px_rgb(255_255_255/0.2),inset_0_-2px_0_-1px_rgb(0_0_0/0.3),inset_0_0_0_1px_color-mix(in_oklab,var(--rb-accent,oklch(100%_0_0))_88%,black),0_1px_1px_rgb(0_0_0/0.66),0_2px_5px_-2px_rgb(0_0_0/0.9)] dark:active:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--rb-accent,oklch(100%_0_0))_88%,black),inset_0_1px_2px_rgb(0_0_0/0.42)] dark:disabled:shadow-none";
const buttonMd =
  "h-8 gap-2 rounded-[var(--rb-r-sm,6px)] px-4 text-[14px]/[16px] font-[450]";

type Props = {
  onImport: () => void;
  onImportPath: (path: string) => void;
  busy: boolean;
};

const VIDEO_EXTS = ["mp4", "mov", "mkv", "webm", "avi", "m4v", "ts", "flv"];

export default function EmptyState5({ onImport, onImportPath, busy }: Props) {
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    setDropError(null);
    if (busy) return;
    const file = e.dataTransfer.files[0];
    if (file === undefined) return;
    const ext = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
    if (!VIDEO_EXTS.includes(ext)) {
      setDropError("暂不支持该文件格式，请使用 mp4 / mov / mkv / webm / avi / m4v / ts / flv");
      return;
    }
    // pathForFile 只认真实文件系统里的 File，合成对象会抛错，按「拖进来的不是磁盘文件」处理
    let path: string;
    try {
      path = window.vnote.pathForFile(file);
    } catch {
      setDropError("读不到这个文件的路径，请改用「导入视频」选择文件");
      return;
    }
    if (path === "") {
      setDropError("读不到这个文件的路径，请改用「导入视频」选择文件");
      return;
    }
    onImportPath(path);
  };

  return (
    <div
      data-testid="dropzone"
      className={cx(canvas, "flex min-h-0 w-full flex-1 flex-col p-4 sm:p-6")}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="mx-auto flex w-full max-w-[680px] flex-1 flex-col">
        <div className={cx(panel, "flex flex-1 flex-col pt-1")}>
          <div className={cx(panelBody, "flex flex-1 flex-col p-1")}>
            <div
              data-testid="library-empty"
              className={cx(
                dragging ? markEdge : dropEdge,
                dragging && selectedFill,
                cornerSm,
                transition,
                "flex flex-1 flex-col items-center justify-center border-dashed px-6 py-10 text-center",
              )}
            >
              <HugeiconsIcon
                icon={Upload04Icon}
                size={20}
                strokeWidth={1.8}
                aria-hidden="true"
                className={cx(text2, "mt-4")}
              />
              <LuminousType
                as="h2"
                text="还没有处理过的视频"
                align="center"
                fontSize="22px"
                fontWeight={600}
                letterSpacing="-0.015em"
                maxWidth="28ch"
                baseOpacity={0.62}
                className="mt-4"
              />
              <p
                className={cx(emptyDescription, "mx-auto mt-3 text-balance")}
              >
                导入一个视频，把长视频变成按主题阅读的文字笔记和切片。
              </p>

              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  data-testid="import-button"
                  className={cx(primaryButton, buttonMd)}
                  onClick={onImport}
                  disabled={busy}
                >
                  <HugeiconsIcon
                    icon={Upload04Icon}
                    size={16}
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  导入视频
                </button>
              </div>

              <p className={cx(emptyDescription, "mx-auto mt-3")}>
                也可以直接把视频文件拖进这个区域。
              </p>
              {dropError !== null && (
                <p className="mt-2 text-[13px]/[18px] text-[oklch(51%_0.18_26)] dark:text-[oklch(76%_0.14_26)]">
                  {dropError}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
