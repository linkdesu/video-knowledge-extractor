"use client";

import type { JobSnapshot, TopicInfo } from "../../../shared/ipc";
import { useEffect, useState } from "react";
import { fmtClock } from "@/lib/format";
import { topicElapsedSeconds, topicGenerating, topicStateLabel, topicUiState } from "@/lib/topic-state";

type TopicListProps = {
  topics: TopicInfo[];
  selectedId: string | null;
  job: JobSnapshot | null;
  mergeMode: boolean;
  mergePicked: ReadonlySet<string>;
  onSelect: (topicId: string) => void;
  onToggleSelected: (topicId: string, selected: boolean) => void;
  onToggleMergePick: (topicId: string) => void;
};
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

const topicBase: React.CSSProperties = {
  border: "1px solid var(--vn-line)",
  borderRadius: 14,
  padding: "12px 14px",
  background: "rgba(255,255,255,0.02)",
  transition: "0.16s",
};

function Row({
  topic,
  selected,
  job,
  now,
  mergeMode,
  mergePicked,
  onSelect,
  onToggleSelected,
  onToggleMergePick,
}: {
  topic: TopicInfo;
  selected: boolean;
  job: JobSnapshot | null;
  now: number;
  mergeMode: boolean;
  mergePicked: ReadonlySet<string>;
  onSelect: (topicId: string) => void;
  onToggleSelected: (topicId: string, selected: boolean) => void;
  onToggleMergePick: (topicId: string) => void;
}) {
  const state = topicUiState(topic, topicGenerating(topic, job));
  return (
    <div
      data-testid={`topic-card-${topic.id}`}
      style={
        selected
          ? {
              ...topicBase,
              borderColor: "rgba(34,211,238,0.4)",
              background: "linear-gradient(90deg,rgba(34,211,238,0.08),rgba(139,92,246,0.06))",
            }
          : topicBase
      }
    >
      <label
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
      >
        <input
          type="checkbox"
          checked={topic.selected}
          onChange={(e) => onToggleSelected(topic.id, e.target.checked)}
          aria-label={`生成笔记：${topic.title}`}
        />
        <span style={{ fontSize: 14, color: "var(--vn-fg)", flex: 1, minWidth: 0 }}>
          {topic.title}
        </span>
      </label>
      <div
        style={{
          color: "var(--vn-dim)",
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
          marginTop: 4,
        }}
      >
        {topic.segments.map((s) => `${fmtClock(s.start)}–${fmtClock(s.end)}`).join(" · ")}
      </div>
      <p
        style={{
          margin: "5px 0 0",
          color: "var(--vn-muted)",
          fontSize: 12,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {topic.summary}
      </p>
      {mergeMode ? (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            color: "var(--vn-dim)",
            marginTop: 8,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={mergePicked.has(topic.id)}
            onChange={() => onToggleMergePick(topic.id)}
            aria-label={`选入合并：${topic.title}`}
          />
          选入合并
        </label>
      ) : null}
      <div
        style={{
          fontSize: 11,
          color: "var(--vn-dim)",
          marginTop: 6,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {topicStateLabel(state, topicElapsedSeconds(topic, job, now))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
        <button
          type="button"
          className="vn-btn sm"
          data-testid={`topic-view-${topic.id}`}
          onClick={() => onSelect(topic.id)}
        >
          查看字幕
        </button>
      </div>
    </div>
  );
}

// 主题列表：勾选框 + 时间段 + 摘要 + 「查看字幕」按钮；
// 合并模式下每个主题多一个「选入合并」勾选框。
export function TopicList({
  topics,
  selectedId,
  job,
  mergeMode,
  mergePicked,
  onSelect,
  onToggleSelected,
  onToggleMergePick,
}: TopicListProps) {
  const anyGenerating = topics.some((t) => topicGenerating(t, job));
  const now = useNow(anyGenerating);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {topics.map((t) => (
        <Row
          key={t.id}
          topic={t}
          selected={t.id === selectedId}
          job={job}
          now={now}
          mergeMode={mergeMode}
          mergePicked={mergePicked}
          onSelect={onSelect}
          onToggleSelected={onToggleSelected}
          onToggleMergePick={onToggleMergePick}
        />
      ))}
    </div>
  );
}
