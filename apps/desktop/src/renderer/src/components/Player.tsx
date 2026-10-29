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
  /** r33：定位并播放（字幕/段标题点击跳转）。play() 的 rejection 吞掉。 */
  seekAndPlay: (seconds: number) => void;
};

type Props = {
  /** 源视频 media url；null 时直接显示占位。 */
  mediaUrl: string | null;
  /** 源视频路径；用于识别内置播放器不支持的容器格式。 */
  sourcePath?: string | null;
  onTime?: (t: number) => void;
  /** 当前主题的时间段；占位与角标显示用。 */
  ranges?: SegmentInfo[];
  /** 固定容器高度（px）；null/undefined 保持现状自适应（maxHeight 62vh）。 */
  height?: number | null;
};

// 源视频播放器：格式不可播（error）或没有 mediaUrl 时回退到占位。
export const Player = forwardRef<PlayerHandle, Props>(function Player(
  { mediaUrl, sourcePath, onTime, ranges, height },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState(false);
  const [t, setT] = useState(0);

  const showPlaceholder = mediaUrl === null || error;
  const mpegTs = /\.(ts|mts|m2ts)$/i.test(sourcePath ?? "");

  const seek = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (video === null || mediaUrl === null || error) return;
      video.currentTime = Math.max(0, seconds);
      setT(seconds);
    },
    [mediaUrl, error],
  );

  const seekAndPlay = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (video === null || mediaUrl === null || error) return;
      video.currentTime = Math.max(0, seconds);
      setT(seconds);
      // 自动播放被拒绝（如策略限制）时定位仍生效，吞掉 rejection。
      void video.play().catch(() => undefined);
    },
    [mediaUrl, error],
  );

  useImperativeHandle(ref, () => ({ seek, seekAndPlay }), [seek, seekAndPlay]);

  return (
    <div
      data-testid="player"
      style={{
        position: "relative",
        borderRadius: 16,
        overflow: "hidden",
        border: "1px solid var(--vn-line)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // 占位态使用可随内容增高的纵向流，避免错误文案在矮容器被裁切。
        ...(showPlaceholder
          ? {
              flexDirection: "column",
              gap: 12,
              padding: 24,
              minHeight: 220,
              background:
                "radial-gradient(200px 160px at 70% 20%, rgba(139,92,246,0.35), transparent 70%), linear-gradient(160deg,#101322,#07080d)",
            }
          : { background: "#07080d", ...(height !== null && height !== undefined ? { height } : { minHeight: 240 }) }),
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
          {error && mpegTs ? (
            <p
              data-testid="player-unsupported-format"
              role="status"
              style={{
                maxWidth: 360,
                margin: 0,
                color: "var(--vn-muted)",
                fontSize: 14,
                fontWeight: 500,
                lineHeight: 1.7,
                textAlign: "center",
              }}
            >
              当前源容器（MPEG-TS）不支持在内置播放器直接预览，主题切片（MP4）与笔记提取不受影响
            </p>
          ) : (
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
          )}
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
            // 固定高度模式（r33）：容器定高，视频 contain 铺满容器。
            // 必须绝对定位：grid 行高按内容回推，百分比 max-height/max-width 会以视频
            // 自身固有尺寸为基准，竖屏视频撑到 507×1099 后被 overflow:hidden 裁掉（r33 QA P1）。
            ...(height !== null && height !== undefined
              ? {
                  position: "absolute" as const,
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "contain" as const,
                }
              : { maxHeight: "62vh", maxWidth: "100%", width: "auto", height: "auto" }),
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
