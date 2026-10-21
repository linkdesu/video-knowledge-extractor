import { useCallback, useRef, useState } from "react";
import type { ClipInfo, SegmentInfo, TranscriptInfo } from "../../../shared/ipc";
import { fmtClock } from "@/lib/format";
import { showToast } from "@/lib/toast";

type ClipBlockProps = {
  index: number;
  segment: SegmentInfo;
  /** 覆盖该 segment 的 clip；需要重跑且没有 clip 覆盖时为 null。 */
  clip: ClipInfo | null;
  transcript: TranscriptInfo | null;
};

function speakerOf(speakerId: string, transcript: TranscriptInfo | null): { name: string; color: string } {
  const spk = transcript?.speakers.find((s) => s.id === speakerId);
  return { name: spk?.name ?? "说话人", color: spk?.color ?? "#94a3b8" };
}

export function ClipBlock({ index, segment, clip, transcript }: ClipBlockProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [seekAt, setSeekAt] = useState<number | null>(null);

  const handleSeek = useCallback(
    (at: number) => {
      const video = videoRef.current;
      if (video === null || clip === null) return;
      video.currentTime = Math.max(0, at - clip.startSeconds);
      setSeekAt(at);
      showToast(`已定位到 ${fmtClock(at)}`);
    },
    [clip],
  );

  const subs =
    transcript === null
      ? []
      : transcript.utterances.filter((u) => u.start >= segment.start && u.start < segment.end);

  return (
    <div data-testid="clip-block">
      {clip !== null ? (
        <div className="overflow-hidden rounded-[10px] border border-neutral-900/10 dark:border-neutral-100/14">
          <video
            ref={(el) => {
              videoRef.current = el;
            }}
            src={clip.mediaUrl}
            controls
            className="max-h-[220px] w-full bg-black object-contain"
          />
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] tabular-nums text-neutral-900/66 dark:text-neutral-100/66">
            <span className="shrink-0">clip-0{index + 1}.mp4</span>
            <span className="truncate">
              {fmtClock(segment.start)}–{fmtClock(segment.end)}
              {seekAt !== null ? ` · 已跳到 ${fmtClock(seekAt)}` : ""}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex h-[74px] items-center justify-center gap-2 rounded-t-[10px] border border-b-0 border-neutral-900/10 bg-[#1e293b] text-[11px] text-[#94a3b8] dark:border-neutral-100/14">
          ▶ clip-0{index + 1}.mp4 · 待重新生成
        </div>
      )}
      <div className="mb-3.5 overflow-hidden rounded-b-[10px] border border-neutral-900/10 dark:border-neutral-100/14">
        {subs.length === 0 ? (
          <div className="cursor-default px-2.5 py-1.5 text-[11px] text-neutral-900/40 dark:text-neutral-100/40">
            该片段无字幕
          </div>
        ) : (
          subs.map((u, i) => {
            const spk = speakerOf(u.speakerId, transcript);
            const on = seekAt === u.start;
            return (
              <button
                key={i}
                type="button"
                data-testid="clip-sub"
                onClick={() => handleSeek(u.start)}
                className={`grid w-full cursor-pointer grid-cols-[42px_64px_1fr] items-start gap-1.5 border-b border-neutral-900/8 px-2.5 py-1.5 text-left text-[11px] last:border-b-0 hover:bg-neutral-900/4 dark:border-neutral-100/8 dark:hover:bg-neutral-100/4 ${
                  on ? "bg-[#22d3ee]/8" : ""
                }`}
              >
                <span className="text-neutral-900/66 tabular-nums dark:text-neutral-100/66">
                  {fmtClock(u.start)}
                </span>
                <span
                  className="rounded px-1.5 py-0.5"
                  style={{ color: spk.color, background: `${spk.color}1f` }}
                >
                  {spk.name}
                </span>
                <span>{u.text}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
