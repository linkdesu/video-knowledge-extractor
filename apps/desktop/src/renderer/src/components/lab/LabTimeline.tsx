"use client";

import { useRef, useState } from "react";
import type { LabConfig, LabLine } from "../../../../shared/lab";
import { formatTime, labLineKey, type LabRow } from "../../../../shared/lab-view";
import { isFillerLine } from "../../../../shared/lab-fillers";

/** A/B 对比时间轴：两条色带 + 差异竖线 + 播放头；可缩放、横向拖动。 */
export function LabTimeline({
  configA,
  configB,
  rows,
  duration,
  currentTime,
  selectedKey,
  threshold,
  colorFor,
  onPlay,
  onPickTime,
}: {
  configA: LabConfig;
  configB: LabConfig;
  rows: LabRow[];
  duration: number;
  currentTime: number;
  selectedKey: string | null;
  threshold: number;
  colorFor: (speakerId: string) => string;
  onPlay: (line: LabLine) => void;
  onPickTime: (seconds: number) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; left: number; captured: boolean; pointerId: number } | null>(null);
  const span = Math.max(duration, 1);
  const pct = (seconds: number) => `${(seconds / span) * 100}%`;

  const band = (config: LabConfig, label: string, testId: string) => (
    <div className="vn-lab-band" data-testid={testId}>
      <span className="vn-lab-band-label">{label}</span>
      {config.lines.map((line, i) => {
        const filtered = config.name === "refine_filter" && isFillerLine(line, threshold);
        return (
          <button
            key={`${testId}-${labLineKey(line)}`}
            type="button"
            className={`vn-lab-seg${filtered ? " filtered" : ""}${labLineKey(line) === selectedKey ? " on" : ""}`}
            data-testid={`lab-band-seg-${i}`}
            title={`${formatTime(line.start)} ${line.speakerId} ${line.text}`}
            style={{
              left: pct(line.start),
              width: `max(2px, ${pct(Math.max(line.end - line.start, span * 0.0008))})`,
              background: filtered ? undefined : colorFor(line.speakerId),
            }}
            onClick={(e) => {
              e.stopPropagation();
              onPlay(line);
            }}
          />
        );
      })}
    </div>
  );

  return (
    <section className="vn-card vn-pad vn-lab-timeline-card">
      <div className="vn-row vn-between vn-lab-timeline-head">
        <b>对比时间轴</b>
        <span className="vn-lab-zoom">
          <button className="vn-btn sm" onClick={() => setZoom((z) => Math.max(1, z / 1.6))}>−</button>
          <span>{zoom.toFixed(1)}×</span>
          <button className="vn-btn sm" onClick={() => setZoom((z) => Math.min(16, z * 1.6))}>＋</button>
        </span>
      </div>
      <div
        className="vn-lab-timeline-scroll"
        ref={scrollRef}
        data-testid="lab-timeline"
        onPointerDown={(e) => {
          const el = scrollRef.current;
          if (el === null) return;
          // 先记起点；移动超过阈值才真的拖动，否则 pointer capture 会吞掉段落的 click。
          drag.current = { x: e.clientX, left: el.scrollLeft, captured: false, pointerId: e.pointerId };
        }}
        onPointerMove={(e) => {
          const el = scrollRef.current;
          const state = drag.current;
          if (el === null || state === null) return;
          const dx = e.clientX - state.x;
          if (!state.captured) {
            if (Math.abs(dx) < 4) return;
            el.setPointerCapture(state.pointerId);
            state.captured = true;
          }
          el.scrollLeft = state.left - dx;
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <div
          className="vn-lab-timeline-track"
          ref={trackRef}
          style={{ width: `${zoom * 100}%` }}
          onClick={(e) => {
            const track = trackRef.current;
            if (track === null) return;
            const box = track.getBoundingClientRect();
            const ratio = (e.clientX - box.left) / Math.max(box.width, 1);
            onPickTime(Math.min(span, Math.max(0, ratio * span)));
          }}
        >
          {band(configA, "A", "lab-timeline-a")}
          <div className="vn-lab-diff-layer">
            {rows.map((row, i) => (row.diff ? <i key={labLineKey(row.line)} data-testid={`lab-diff-marker-${i}`} style={{ left: pct(row.line.start) }} /> : null))}
          </div>
          {band(configB, "B", "lab-timeline-b")}
          <div className="vn-lab-playhead" data-testid="lab-playhead" style={{ left: pct(currentTime) }} />
          <div className="vn-lab-axis">
            <span>0:00</span>
            <span>{formatTime(span / 2)}</span>
            <span>{formatTime(span)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
