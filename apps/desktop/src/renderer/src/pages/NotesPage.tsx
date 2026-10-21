import { useEffect, useState } from "react";
import type { PageContext } from "./types";
import { ClipBlock } from "../components/ClipBlock";
import { NoteList, generatingProgress } from "../components/NoteList";
import { ProgressBar } from "@/rbp/blocks/monitoring-9";
import { fmtClock, fmtElapsed } from "@/lib/format";
import { showToast } from "@/lib/toast";

const BTN =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap select-none transition-[color,background-color,border-color,box-shadow,outline-color,scale,filter] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.98] motion-reduce:active:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rb-accent,oklch(20.5%_0_0))] dark:focus-visible:outline-[var(--rb-accent,oklch(100%_0_0))] border border-neutral-900/12 bg-white text-neutral-900 shadow-[0_1px_2px_-1px_rgb(0_0_0/0.12)] hover:not-disabled:border-neutral-900/32 hover:not-disabled:bg-linear-to-b hover:not-disabled:from-neutral-900/3 hover:not-disabled:to-neutral-900/3 active:shadow-[inset_0_1px_2px_rgb(0_0_0/0.12)] disabled:border-neutral-900/8 disabled:text-neutral-900/40 disabled:shadow-none dark:border-neutral-100/14 dark:bg-neutral-900 dark:text-neutral-100 dark:shadow-[0_1px_2px_-1px_rgb(0_0_0/0.36)] dark:hover:not-disabled:border-neutral-100/32 dark:hover:not-disabled:from-neutral-100/3 dark:hover:not-disabled:to-neutral-100/3 dark:active:shadow-[inset_0_1px_2px_rgb(0_0_0/0.4)] dark:disabled:border-neutral-100/8 dark:disabled:text-neutral-100/40";
const BTN_SM = "h-7 gap-1.5 rounded-[6px] px-3 text-[14px]/[16px] font-[450]";
const CARD =
  "flex min-w-0 flex-col rounded-[10px] border border-neutral-900/10 bg-white text-neutral-900 shadow-[0_12px_32px_-8px_rgb(0_0_0/0.55)] dark:border-neutral-100/14 dark:bg-neutral-900 dark:text-neutral-100 dark:shadow-[0_12px_40px_-8px_rgb(0_0_0/0.75)]";
const CARD_PAD = "p-3.5";
const TEXT3 = "text-neutral-900/66 dark:text-neutral-100/66";

export function NotesPage({ detail, job, onPage, onStartNotes }: PageContext) {
  const topics = detail.topics;
  const [selectedId, setSelectedId] = useState<string | null>(
    () => topics.find((t) => t.status !== "queued")?.id ?? topics[0]?.id ?? null,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
  }, [job]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const selected = topics.find((t) => t.id === selectedId) ?? null;
  const selProg = selected !== null ? generatingProgress(selected, job, now) : null;

  const rerunOne = async () => {
    if (selected === null) return;
    try {
      await onStartNotes([selected.id]);
    } catch {
      showToast("重新生成失败");
    }
  };

  const reveal = () => void window.vnote.reveal(detail.video.outputDir);

  return (
    <div className="flex h-full min-w-0 flex-col gap-3.5 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[24px] font-[450] tracking-[-0.015em]">笔记</h1>
        <div className="flex items-center gap-3">
          <span className={`max-w-[420px] truncate text-[12px] ${TEXT3}`} title={detail.video.outputDir}>
            输出目录：{detail.video.outputDir}
          </span>
          <button type="button" onClick={reveal} className={`${BTN} ${BTN_SM}`}>
            打开输出目录
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3.5 lg:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-3.5 overflow-y-auto">
          {selected === null ? (
            <button
              type="button"
              onClick={() => onPage("topics")}
              className={`${CARD} ${CARD_PAD} cursor-pointer text-left text-[13px] ${TEXT3} hover:border-neutral-900/25 dark:hover:border-neutral-100/30`}
            >
              还没有主题，去主题页生成 →
            </button>
          ) : (
            <>
              <div className={`${CARD} ${CARD_PAD}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <b className="text-[16px]">{selected.title}</b>
                  <span className="flex flex-wrap gap-1">
                    {selected.segments.map((s, i) => (
                      <span
                        key={i}
                        className="rounded border border-neutral-900/10 px-1.5 py-0.5 text-[11px] tabular-nums text-neutral-900/66 dark:border-neutral-100/14 dark:text-neutral-100/66"
                      >
                        {fmtClock(s.start)}–{fmtClock(s.end)}
                      </span>
                    ))}
                  </span>
                </div>
                {selected.keyPoints.length > 0 ? (
                  <ul className="mt-2.5 list-disc pl-[18px] text-[12px] text-neutral-900/66 dark:text-neutral-100/66">
                    {selected.keyPoints.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                ) : null}
                {selProg !== null ? (
                  <div className="mt-3">
                    <ProgressBar percent={selProg.percent ?? 0} />
                    <div className="mt-1 flex justify-between text-[10px] tabular-nums text-neutral-900/66 dark:text-neutral-100/66">
                      <span>已用 {fmtElapsed(selProg.elapsedSeconds)}</span>
                      {selProg.percent !== null ? <span>{Math.round(selProg.percent)}%</span> : null}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className={`${CARD} ${CARD_PAD}`}>
                <b className="text-[13px]">视频片段</b>
                <div className="mt-2.5 flex flex-col">
                  {selected.segments.map((seg, i) => {
                    const clip = selected.clips.find((c) => c.segmentIndexes.includes(i));
                    return (
                      <ClipBlock
                        key={`${selected.id}-${i}`}
                        index={i}
                        segment={seg}
                        clip={clip ?? null}
                        transcript={detail.transcript}
                      />
                    );
                  })}
                </div>
              </div>

              <div className="flex gap-2">
                <button type="button" onClick={() => void rerunOne()} className={`${BTN} ${BTN_SM}`}>
                  单独重新生成
                </button>
              </div>
            </>
          )}
        </div>

        <div className={`${CARD} min-h-0 overflow-hidden`}>
          <NoteList topics={topics} selectedId={selectedId} onSelect={setSelectedId} job={job} now={now} />
        </div>
      </div>
    </div>
  );
}
