import { useEffect, useRef, useState } from "react";
import type { PageContext } from "./types";
import { NoteList, generatingProgress } from "../components/NoteList";
import { ProgressBar } from "@/rbp/blocks/monitoring-9";
import { fmtClock, fmtElapsed } from "@/lib/format";
import { clipSeekTarget } from "@/lib/playback";
import { showToast } from "@/lib/toast";
import { resolveSpeakerName } from "@/lib/speaker-resolve";

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
  const [rerunPending, setRerunPending] = useState(false);

  useEffect(() => {
    setNow(Date.now());
  }, [job]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const selected = topics.find((t) => t.id === selectedId) ?? null;
  const selProg = selected !== null ? generatingProgress(selected, job, now) : null;
  // 本视频的 notes 任务在途（queued/running）或当前主题在排/生成中时禁用重生成按钮。
  const jobActiveForVideo =
    job !== null && (job.state === "queued" || job.state === "running") && job.videoId === detail.video.id;
  const topicBusy = selected !== null && (selected.status === "queued" || selected.status === "generating");

  const rerunOne = async () => {
    if (selected === null) return;
    setRerunPending(true);
    try {
      await onStartNotes([selected.id], { force: true });
    } catch {
      // App 层已弹「生成笔记失败」toast，这里不重复弹
    } finally {
      setRerunPending(false);
    }
  };

  const reveal = () => void window.vnote.reveal(detail.video.outputDir);
  // r33：每个主题只渲染一个播放器，用 clips[0]（topic.mp4）+ 段偏移。
  const clip =
    selected !== null && selected.clips.length === 1 ? (selected.clips[0] ?? null) : null;
  const clipPlayer = clip !== null && clip.segmentOffsets.length > 0 ? clip : null;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const seekClip = (seconds: number) => {
    const v = videoRef.current;
    if (v === null) return;
    v.currentTime = Math.max(0, seconds);
    void v.play().catch(() => undefined);
  };


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
      {detail.speakersChanged ? (
        <div
          className="rounded-[10px] border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-[13px] text-amber-300/90"
          data-testid="speakers-changed-banner"
        >
          说话人已变更，可重新生成
        </div>
      ) : null}

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
                      <button
                        key={i}
                        type="button"
                        data-testid={`clip-seg-${i}`}
                        onClick={
                          clipPlayer !== null
                            ? () => {
                                const seg = selected.segments[i];
                                if (seg === undefined) return;
                                seekClip(
                                  clipSeekTarget(
                                    { segments: selected.segments, clips: selected.clips },
                                    i,
                                    seg.start,
                                  ).seconds,
                                );
                              }
                            : undefined
                        }
                        className={`rounded border border-neutral-900/10 px-1.5 py-0.5 text-[11px] tabular-nums text-neutral-900/66 dark:border-neutral-100/14 dark:text-neutral-100/66 ${
                          clipPlayer !== null ? "cursor-pointer hover:border-neutral-900/30 dark:hover:border-neutral-100/40" : ""
                        }`}
                      >
                        {fmtClock(s.start)}–{fmtClock(s.end)}
                      </button>
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
                <div data-testid="clip-block">
                  {clipPlayer !== null ? (
                    <div className="mt-2.5 overflow-hidden rounded-[10px] border border-neutral-900/10 dark:border-neutral-100/14">
                      <video
                        ref={videoRef}
                        data-testid="clip-player"
                        src={clipPlayer.mediaUrl}
                        controls
                        className="max-h-[280px] w-full bg-black object-contain"
                      />
                    </div>
                  ) : (
                    <div className="mt-2.5 flex h-[74px] items-center justify-center rounded-[10px] border border-neutral-900/10 bg-[#1e293b] text-[11px] text-[#94a3b8] dark:border-neutral-100/14">
                      ▶ topic.mp4 · 待重新生成
                    </div>
                  )}
                  {clipPlayer !== null ? (
                    <div className="mt-2.5 flex flex-col gap-2">
                      {selected.segments.map((seg, i) => {
                        const subs = (detail.transcript?.utterances ?? []).filter(
                          (u) => u.start >= seg.start && u.start < seg.end,
                        );
                        const rows = subs.map((u) => {
                          const sp = resolveSpeakerName(detail.transcript?.speakers ?? [], u.speakerId);
                          return {
                            start: u.start,
                            text: u.text,
                            speakerName: sp.name,
                            speakerColor: sp.color,
                          };
                        });
                        return (
                          <div key={i}>
                            <div className="mb-1 text-[11px] tabular-nums text-neutral-900/66 dark:text-neutral-100/66">
                              段 {i + 1} · {fmtClock(seg.start)}–{fmtClock(seg.end)}
                            </div>
                            {rows.length === 0 ? (
                              <div className="px-2.5 py-1.5 text-[11px] text-neutral-900/40 dark:text-neutral-100/40">
                                该片段无字幕
                              </div>
                            ) : (
                              <div className="overflow-hidden rounded-[10px] border border-neutral-900/10 dark:border-neutral-100/14">
                                {rows.map((r) => (
                                  <button
                                    key={r.start}
                                    type="button"
                                    data-testid="clip-sub"
                                    onClick={() =>
                                      seekClip(
                                        clipSeekTarget(
                                          { segments: selected.segments, clips: selected.clips },
                                          i,
                                          r.start,
                                        ).seconds,
                                      )
                                    }
                                    className="grid w-full cursor-pointer grid-cols-[42px_64px_1fr] items-start gap-1.5 border-b border-neutral-900/8 px-2.5 py-1.5 text-left text-[11px] last:border-b-0 hover:bg-neutral-900/4 dark:border-neutral-100/8 dark:hover:bg-neutral-100/4"
                                  >
                                    <span className="text-neutral-900/66 tabular-nums dark:text-neutral-100/66">
                                      {fmtClock(r.start)}
                                    </span>
                                    <span
                                      className="rounded px-1.5 py-0.5"
                                      style={{ color: r.speakerColor, background: `${r.speakerColor}1f` }}
                                    >
                                      {r.speakerName}
                                    </span>
                                    <span>{r.text}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void rerunOne()}
                  disabled={rerunPending || jobActiveForVideo || topicBusy}
                  className={`${BTN} ${BTN_SM}`}
                >
                  {rerunPending ? "生成中…" : "单独重新生成"}
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
