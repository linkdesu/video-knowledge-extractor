"use client";

import { useEffect, useMemo, useState } from "react";
import type { SpeakerInfo } from "../../../shared/ipc";
import type { PageContext } from "./types";
import { Workspace } from "@/rbp/blocks/app-shell-6";
import { Player } from "@/components/Player";
import { SubtitleList } from "@/components/SubtitleList";
import { TopicList, generatingProgress } from "@/components/TopicList";
import { ProgressBar } from "@/rbp/blocks/monitoring-9";
import { errMessage, fmtClock, fmtElapsed } from "@/lib/format";
import { showToast } from "@/lib/toast";

// 主题页：左（播放器 + 当前主题按段原始字幕，可删单条/整段）右（主题列表 + 合并）。
export function TopicsPage({ detail, job, onRefresh, onStartNotes }: PageContext) {
  const topics = detail.topics;
  const [selectedId, setSelectedId] = useState<string | null>(() => topics[0]?.id ?? null);
  const [mergeMode, setMergeMode] = useState(false);
  const [mergePicked, setMergePicked] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const anyGenerating = topics.some((t) => t.status === "generating");
  useEffect(() => {
    if (!anyGenerating) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [anyGenerating]);

  const selected = useMemo(
    () => topics.find((t) => t.id === selectedId) ?? topics[0] ?? null,
    [topics, selectedId],
  );

  const selectedCount = topics.filter((t) => t.selected).length;
  const selectedIds = topics.filter((t) => t.selected).map((t) => t.id);
  const pickedCount = mergePicked.size;
  const selProg = selected !== null ? generatingProgress(selected, job, now) : null;

  const speakerById = useMemo(() => {
    const m: Record<string, SpeakerInfo> = {};
    for (const s of detail.transcript?.speakers ?? []) m[s.id] = s;
    return (id: string) => m[id] ?? { id, name: id, color: "#9aa3b8" };
  }, [detail.transcript?.speakers]);

  const startNotes = () => {
    if (selectedIds.length === 0) {
      showToast("先勾选要生成的主题");
      return;
    }
    void onStartNotes(selectedIds);
  };

  const toggleMergePick = (topicId: string) => {
    setMergePicked((prev) => {
      const next = new Set(prev);
      if (next.has(topicId)) next.delete(topicId);
      else next.add(topicId);
      return next;
    });
  };

  const confirmMerge = () => {
    if (pickedCount < 2) {
      showToast("至少勾选两个主题");
      return;
    }
    const ids = [...mergePicked];
    window.vnote
      .mergeTopics(detail.video.id, ids)
      .then(async () => {
        await onRefresh();
        showToast(`已合并 ${ids.length} 个主题`);
        setMergeMode(false);
        setMergePicked(() => new Set());
      })
      .catch((err) => showToast(`合并失败：${errMessage(err)}`));
  };

  const toggleSelected = (topicId: string, sel: boolean) => {
    window.vnote
      .setTopicSelected(detail.video.id, topicId, sel)
      .then(async () => {
        await onRefresh();
        showToast(sel ? "已勾选生成该主题" : "已取消勾选该主题");
      })
      .catch((err) => showToast(`操作失败：${errMessage(err)}`));
  };

  const deleteSegment = (topicId: string, segmentIndex: number) => {
    window.vnote
      .deleteTopicSegment(detail.video.id, topicId, segmentIndex)
      .then(async () => {
        await onRefresh();
        showToast("已删除该片段");
      })
      .catch((err) => showToast(errMessage(err)));
  };

  const deleteCue = (index: number) => {
    window.vnote
      .deleteUtterance(detail.video.id, index)
      .then(async () => {
        await onRefresh();
        showToast("已删除该条字幕");
      })
      .catch((err) => showToast(`删除失败：${errMessage(err)}`));
  };

  return (
    <Workspace
      title="主题"
      subtitle={`已选 ${selectedCount} / ${topics.length} 个 · 主题可包含多个不连续时间段`}
      actions={
        <>
          {mergeMode ? (
            <>
              <button
                type="button"
                className="vn-btn sm"
                data-testid="topics-merge-cancel"
                onClick={() => {
                  setMergeMode(false);
                  setMergePicked(() => new Set());
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="vn-btn primary sm"
                data-testid="topics-merge-confirm"
                onClick={confirmMerge}
              >
                确认合并 ({pickedCount})
              </button>
            </>
          ) : (
            <button
              type="button"
              className="vn-btn sm"
              data-testid="topics-merge-start"
              onClick={() => setMergeMode(true)}
            >
              合并主题
            </button>
          )}
          <button
            type="button"
            className="vn-btn primary sm"
            data-testid="topics-generate"
            onClick={startNotes}
          >
            生成所选主题笔记 ({selectedCount})
          </button>
        </>
      }
      detail={
        selected === null ? (
          <div className="vn-card" style={{ color: "var(--vn-muted)", fontSize: 12 }}>
            还没有主题，去转写后生成。
          </div>
        ) : (
          <>
            <Player mediaUrl={detail.mediaUrl} ranges={selected.segments} />
            <div className="vn-card" style={{ marginTop: 14 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "11px 14px",
                  borderBottom: "1px solid var(--vn-line)",
                  fontSize: 12,
                  color: "var(--vn-muted)",
                }}
              >
                <span>{selected.title} · 原始字幕（按段）</span>
                <span className="vn-hint">可删除单条字幕/整段</span>
              </div>
              {selProg !== null ? (
                <div style={{ padding: "12px 14px 0" }}>
                  <ProgressBar percent={selProg.percent ?? 0} />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 10.5,
                      color: "var(--vn-dim)",
                      marginTop: 4,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    <span>已用 {fmtElapsed(selProg.elapsedSeconds)}</span>
                    <span>{Math.round(selProg.percent ?? 0)}%</span>
                  </div>
                </div>
              ) : null}
              <div style={{ padding: 14 }}>
                {selected.segments.map((seg, gi) => {
                  const cues = (detail.transcript?.utterances ?? []).filter(
                    (u) => u.start >= seg.start && u.start < seg.end,
                  );
                  const rows = cues.map((u) => {
                    const sp = speakerById(u.speakerId);
                    return {
                      index: u.index,
                      start: u.start,
                      text: u.text,
                      speakerName: sp.name,
                      speakerColor: sp.color,
                    };
                  });
                  return (
                    <div key={gi} style={{ marginBottom: 16 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          margin: "0 0 6px",
                          fontSize: 12,
                          color: "var(--vn-dim)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        <span>
                          段 {gi + 1} · {fmtClock(seg.start)}–{fmtClock(seg.end)}
                        </span>
                        <button
                          type="button"
                          className="vn-btn sm"
                          data-testid={`topic-delete-seg-${gi}`}
                          style={{ padding: "3px 9px", fontSize: 11 }}
                          onClick={() => deleteSegment(selected.id, gi)}
                        >
                          删除此段
                        </button>
                      </div>
                      {rows.length > 0 ? (
                        <SubtitleList
                          rows={rows}
                          maxHeight={gi === 0 ? 260 : 180}
                          onDelete={deleteCue}
                        />
                      ) : (
                        <div style={{ color: "var(--vn-dim)", fontSize: 12, padding: "6px 14px" }}>
                          该片段无字幕
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )
      }
      aside={
        <TopicList
          topics={topics}
          selectedId={selected?.id ?? null}
          job={job}
          mergeMode={mergeMode}
          mergePicked={mergePicked}
          onSelect={setSelectedId}
          onToggleSelected={toggleSelected}
          onToggleMergePick={toggleMergePick}
        />
      }
    />
  );
}
