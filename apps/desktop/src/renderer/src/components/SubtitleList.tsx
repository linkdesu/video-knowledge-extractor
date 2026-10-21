"use client";

import { useEffect, useRef, useState } from "react";
import { fmtClock } from "@/lib/format";

type SubtitleListProps = {
  rows: Array<{
    start: number;
    text: string;
    speakerName: string;
    speakerColor: string;
    /** 原始转写下标；删除接口用它，不传则纯展示。 */
    index?: number;
  }>;
  /** 当前播放命中的行下标（rows 数组内），用于高亮。 */
  activeIndex?: number | null;
  /** 点行定位播放器；传 null 表示纯展示。 */
  onSeek?: (seconds: number) => void;
  maxHeight?: number;
  /** 可编辑模式：每行多一个删除按钮。 */
  onDelete?: (index: number) => void;
};

// 字幕行列表：时间 + 说话人颜色点 + 姓名（不显示说话人编号），点行定位。
// 播放时当前行高亮并随播放自动滚动；用户手动滚动时暂停自动滚动。
export function SubtitleList({
  rows,
  activeIndex,
  onSeek,
  maxHeight = 520,
  onDelete,
}: SubtitleListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const suppressUntil = useRef(0);

  useEffect(() => {
    if (activeIndex === null || activeIndex === undefined || !autoScroll) return;
    const el = listRef.current;
    const row = el?.children.item(activeIndex) as HTMLElement | null;
    if (el !== null && row !== null && window.performance.now() > suppressUntil.current) {
      const top = row.offsetTop - el.offsetTop;
      const bottom = top + row.offsetHeight;
      if (top < el.scrollTop + 8 || bottom > el.scrollTop + el.clientHeight - 8) {
        el.scrollTo({ top, behavior: "smooth" });
      }
    }
  }, [activeIndex, autoScroll]);

  return (
    <div
      ref={listRef}
      data-testid="subtitle-list"
      onScroll={() => {
        suppressUntil.current = window.performance.now() + 2500;
        setAutoScroll(false);
      }}
      style={{
        maxHeight,
        overflow: "auto",
        borderRadius: 14,
        border: "1px solid var(--vn-line)",
        background: "rgba(9,11,18,0.5)",
      }}
    >
      {rows.map((r, i) => {
        const active = activeIndex !== null && activeIndex !== undefined && activeIndex === i;
        return (
          <div
            key={r.index !== undefined ? r.index : i}
            role={onSeek !== undefined ? "button" : undefined}
            tabIndex={onSeek !== undefined ? 0 : undefined}
            onClick={onSeek !== undefined ? () => onSeek(r.start) : undefined}
            onKeyDown={
              onSeek !== undefined
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSeek(r.start);
                    }
                  }
                : undefined
            }
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              padding: "7px 14px",
              borderBottom: "1px solid var(--vn-line)",
              cursor: onSeek !== undefined ? "pointer" : "default",
              background: active ? "rgba(34,211,238,0.10)" : "transparent",
              boxShadow: active ? "inset 2px 0 0 #22d3ee" : "none",
              transition: "0.12s",
            }}
          >
            <span
              style={{
                color: "var(--vn-dim)",
                fontSize: 11,
                fontVariantNumeric: "tabular-nums",
                flexShrink: 0,
              }}
            >
              {fmtClock(r.start)}
            </span>
            <span
              style={{
                color: r.speakerColor,
                background: `${r.speakerColor}1f`,
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 99,
                flexShrink: 0,
              }}
            >
              {r.speakerName}
            </span>
            <span style={{ fontSize: 13, color: "var(--vn-fg)" }}>{r.text}</span>
            {onDelete !== undefined && r.index !== undefined ? (
              // 闭包里对 r.index 的窄化不可靠，先取成常量

              <button
                type="button"
                aria-label="删除这条字幕"
                data-testid={`subtitle-delete-${r.index}`}
                onClick={(e) => {
                  e.stopPropagation();
                  const index = r.index;
                  if (index !== undefined) onDelete(index);
                }}
                style={{
                  marginInlineStart: "auto",
                  background: "none",
                  border: 0,
                  color: "var(--vn-dim)",
                  cursor: "pointer",
                  fontSize: 14,
                  lineHeight: 1,
                  padding: 4,
                }}
              >
                ×
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
