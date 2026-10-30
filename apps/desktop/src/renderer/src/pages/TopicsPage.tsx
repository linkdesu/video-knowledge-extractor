"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { resolveSpeakerName } from "@/lib/speaker-resolve";
import type { PageContext } from "./types";
import { Workspace } from "@/rbp/blocks/app-shell-6";
import { Player, type PlayerHandle } from "@/components/Player";
import { SubtitleList } from "@/components/SubtitleList";
import { TopicList } from "@/components/TopicList";
import { errMessage, fmtClock } from "@/lib/format";
import { topicElapsedSeconds, topicGenerating, topicStateLabel, topicUiState } from "@/lib/topic-state";
import { clipSeekTarget } from "@/lib/playback";
import { showErrorToast, showToast } from "@/lib/toast";

// 播放器高度持久化键（r33 契约：localStorage 只存 UI 状态，键集中在这儿与 lib/lab-view-state.ts 两处）。
const HEIGHT_STORAGE_KEY = "vn.topics.playerHeight";
// 主题页：左（播放器 + 当前主题按段原始字幕，可删单条/整段）右（主题列表 + 合并）。
export function TopicsPage({ detail, job, onRefresh, onStartNotes }: PageContext) {
  const topics = detail.topics;
  const [selectedId, setSelectedId] = useState<string | null>(() => topics[0]?.id ?? null);
  const [mergeMode, setMergeMode] = useState(false);
  const [mergePicked, setMergePicked] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const anyGenerating = topics.some((t) => topicGenerating(t, job));
  useEffect(() => {
    if (!anyGenerating) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [anyGenerating]);

  const selected = useMemo(
    () => topics.find((t) => t.id === selectedId) ?? topics[0] ?? null,
    [topics, selectedId],
  );

  const selectedTopics = topics.filter((t) => t.selected);
  const selectedCount = selectedTopics.length;
  // 只有还没生成过的主题才计入按钮数量，与 core 的 `status !== "done"` 过滤一致。
  const pendingTopics = selectedTopics.filter((t) => t.status !== "done");
  const pendingCount = pendingTopics.length;
  const pickedCount = mergePicked.size;
  const selState = selected !== null ? topicUiState(selected, topicGenerating(selected, job)) : null;

  const resolvedSpeaker = useMemo(
    () => (id: string) => resolveSpeakerName(detail.transcript?.speakers ?? [], id),
    [detail.transcript?.speakers],
  );

  // 播放源（r33）：新文档单条 topic.mp4 切片带段偏移时用切片，否则 source + 时间段。
  const clip =
    selected !== null && selected.clips.length === 1 ? (selected.clips[0] ?? null) : null;
  const clipPlayer = clip !== null && clip.segmentOffsets.length > 0 ? clip : null;

  const playerRef = useRef<PlayerHandle>(null);
  const playerElRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(() => {
    // 已保存的合法值优先（用户拖拽过就以用户的为准）；没有保存时竖屏默认
    // min(420, 60% 窗口高)，横屏自适应。
    const stored = Number(window.localStorage.getItem(HEIGHT_STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= 240 && stored <= 900) return stored;
    const r = detail.video.resolution;
    if (r === null) return 180;
    return r.height > r.width
      ? Math.min(420, Math.round(window.innerHeight * 0.6))
      : null;
  });
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const startResize = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const cur = height !== null ? height : (playerElRef.current?.getBoundingClientRect().height ?? 320);
    dragRef.current = { startY: e.clientY, startH: Math.max(240, Math.min(cur, window.innerHeight * 0.8)) };
  };
  const moveResize = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (d === null) return;
    const max = Math.min(900, window.innerHeight * 0.8);
    setHeight(Math.max(240, Math.min(d.startH + (e.clientY - d.startY), max)));
  };
  const endResize = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (d === null) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
    setHeight((h) => {
      if (h !== null) window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(Math.round(h)));
      return h;
    });
  };

  const startNotes = () => {
    if (selectedCount === 0) {
      showToast("先勾选要生成的主题");
      return;
    }
    if (pendingCount === 0) {
      showToast("所选主题笔记已生成");
      return;
    }
    void onStartNotes(pendingTopics.map((t) => t.id));
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
      .catch((err) => showErrorToast(errMessage(err)));
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
  // 段标题/字幕点击 → 按 clip 偏移或源时间 seekAndPlay（r33 契约 §5）。
  const seekSeg = (gi: number) => {
    if (selected === null) return;
    const seg = selected.segments[gi];
    if (seg === undefined) return;
    playerRef.current?.seekAndPlay(
      clipSeekTarget({ segments: selected.segments, clips: selected.clips }, gi, seg.start).seconds,
    );
  };
  const seekCue = (gi: number) => (t: number) => {
    if (selected === null) return;
    playerRef.current?.seekAndPlay(
      clipSeekTarget({ segments: selected.segments, clips: selected.clips }, gi, t).seconds,
    );
  };


  return (
    <>
      {detail.speakersChanged ? (
        <div className="vn-row" style={{ marginBottom: 10 }}>
          <div
            className="vn-card"
            style={{
              background: "rgba(251,191,36,0.08)",
              border: "1px solid rgba(251,191,36,0.25)",
              padding: "8px 14px",
              fontSize: 13,
              color: "var(--vn-fg)",
            }}
            data-testid="speakers-changed-banner"
          >
            说话人已变更，可重新生成
          </div>
        </div>
      ) : null}
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
            disabled={selectedCount > 0 && pendingCount === 0}
            onClick={startNotes}
          >
            {selectedCount === 0
              ? "生成笔记（0 个新主题）"
              : pendingCount === 0
                ? "所选主题笔记已生成"
                : `生成笔记（${pendingCount} 个新主题）`}
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
            <div ref={playerElRef} style={{ position: "relative" }}>
              <Player
                ref={playerRef}
                mediaUrl={clipPlayer !== null ? clipPlayer.mediaUrl : detail.mediaUrl}
                sourcePath={clipPlayer !== null ? null : detail.playbackPath}
                ranges={clipPlayer !== null ? [] : selected.segments}
                height={height}
              />
              <button
                type="button"
                data-testid="player-resize"
                aria-label="调整播放器高度"
                onPointerDown={startResize}
                onPointerMove={moveResize}
                onPointerUp={endResize}
                onPointerCancel={endResize}
                style={{
                  position: "absolute",
                  right: 8,
                  bottom: 8,
                  zIndex: 20,
                  width: 16,
                  height: 16,
                  cursor: "ns-resize",
                  background: "rgba(0,0,0,0.55)",
                  border: "1px solid rgba(255,255,255,0.3)",
                  borderRadius: 6,
                  color: "var(--vn-muted)",
                  fontSize: 10,
                  lineHeight: "14px",
                  padding: 0,
                }}
              >
                ⇕
              </button>
            </div>
            <div className="vn-card" style={{ marginTop: 10 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 14px",
                  borderBottom: "1px solid var(--vn-line)",
                  fontSize: 12,
                  color: "var(--vn-muted)",
                }}
              >
                <span>{selected.title} · 原始字幕（按段）</span>
                <span className="vn-hint">可删除单条字幕/整段</span>
              </div>
              {selState !== null && selected !== null && (selState.kind === "generating" || selState.kind === "queued") ? (
                <div
                  style={{
                    padding: "12px 14px 0",
                    fontSize: 11,
                    color: "var(--vn-dim)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {topicStateLabel(selState, topicElapsedSeconds(selected, job, now))}
                </div>
              ) : null}
              <div style={{ padding: 14 }}>
                {selected.segments.map((seg, gi) => {
                  const cues = (detail.transcript?.utterances ?? []).filter(
                    (u) => u.start >= seg.start && u.start < seg.end,
                  );
                  const rows = cues.map((u) => {
                    const sp = resolvedSpeaker(u.speakerId);
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
                        <button
                          type="button"
                          data-testid={`topic-seg-${gi}`}
                          onClick={() => seekSeg(gi)}
                          style={{
                            background: "none",
                            border: 0,
                            padding: 0,
                            cursor: "pointer",
                            color: "inherit",
                            font: "inherit",
                          }}
                        >
                          段 {gi + 1} · {fmtClock(seg.start)}–{fmtClock(seg.end)}
                        </button>
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
                          maxHeight={gi === 0 ? "clamp(320px, 42vh, 520px)" : "clamp(240px, 30vh, 400px)"}
                          onDelete={deleteCue}
                          onSeek={seekCue(gi)}
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
    </>
  );
}
