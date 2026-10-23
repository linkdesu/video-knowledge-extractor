"use client";

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { SegmentInfo } from "../../../shared/ipc";
import { fmtClock } from "@/lib/format";

export type PlayerHandle = {
  seek: (seconds: number) => void;
};

type Props = {
  /** 源视频 media url；null 时直接显示占位。 */
  mediaUrl: string | null;
  onTime?: (t: number) => void;
  /** 当前主题的时间段；占位与角标显示用。 */
  ranges?: SegmentInfo[];
};

// 源视频播放器：格式不可播（error）或没有 mediaUrl 时回退到占位。
export const Player = forwardRef<PlayerHandle, Props>(function Player(
  { mediaUrl, onTime, ranges },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState(false);
  const [t, setT] = useState(0);

  const showPlaceholder = mediaUrl === null || error;

  const seek = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (video === null || mediaUrl === null || error) return;
      video.currentTime = Math.max(0, seconds);
      setT(seconds);
    },
    [mediaUrl, error],
  );

  useImperativeHandle(ref, () => ({ seek }), [seek]);

  return (
    <div
      data-testid="player"
      style={{
        position: "relative",
        borderRadius: 16,
        overflow: "hidden",
        border: "1px solid var(--vn-line)",
        display: "grid",
        placeItems: "center",
        // 占位态保留渐变与 16/10；视频态让容器跟随视频真实尺寸居中。
        ...(showPlaceholder
          ? {
              background:
                "radial-gradient(200px 160px at 70% 20%, rgba(139,92,246,0.35), transparent 70%), linear-gradient(160deg,#101322,#07080d)",
              aspectRatio: "16 / 10",
            }
          : { background: "#07080d", minHeight: 240 }),
      }}
    >
      {showPlaceholder ? (
        <>
          <div
            role="img"
            aria-label="播放器"
            style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.25)",
              display: "grid",
              placeItems: "center",
              fontSize: 20,
            }}
          >
            ▶
          </div>
          <span
            style={{
              position: "absolute",
              left: 14,
              bottom: 12,
              fontSize: 11,
              color: "var(--vn-muted)",
            }}
          >
            播放器 · 视频预览
          </span>
        </>
      ) : (
        <video
          ref={videoRef}
          src={mediaUrl ?? undefined}
          controls
          preload="metadata"
          onError={() => setError(true)}
          onTimeUpdate={(e) => {
            setT(e.currentTarget.currentTime);
            onTime?.(e.currentTarget.currentTime);
          }}
          style={{
            display: "block",
            maxWidth: "100%",
            maxHeight: "62vh",
            width: "auto",
            height: "auto",
            background: "#000",
          }}
        />
      )}
      {ranges !== undefined && ranges.length > 0 ? (
        <span
          style={{
            position: "absolute",
            right: 14,
            bottom: showPlaceholder ? 12 : 56,
            fontSize: 11,
            color: "var(--vn-muted)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {ranges.map((r) => `${fmtClock(r.start)}–${fmtClock(r.end)}`).join(" · ")}
        </span>
      ) : null}
    </div>
  );
});
