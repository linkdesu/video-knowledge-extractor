"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { PageContext } from "./types";
import { createPortal } from "react-dom";
import { Workspace } from "@/rbp/blocks/app-shell-6";
import { Player } from "@/components/Player";
import type { PlayerHandle } from "@/components/Player";
import { SubtitleList } from "@/components/SubtitleList";
import { SpeakerPanel } from "@/components/SpeakerPanel";
import { VideoGlossaryPanel } from "@/components/VideoGlossaryPanel";
import { errMessage } from "@/lib/format";
import { showToast } from "@/lib/toast";
import { resolveSpeakerName } from "@/lib/speaker-resolve";

type RerunScope = "topics" | "asr";

// 字幕页：播放器 + 随播放滚动的字幕列表 + 说话人面板 + 本视频专属术语表。
export function TranscriptPage({ detail, onRefresh, onPage, onRebuildTopics, onRerunVideo }: PageContext) {
  const playerRef = useRef<PlayerHandle | null>(null);
  const [t, setT] = useState(0);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [rerunScope, setRerunScope] = useState<RerunScope>("topics");

  // 旧 video.json 写的是 `remote`；main 读时已映射为 `openai`，这里再兼容一层（ADR-0016 §11）。
  const asrEngine: string | null = detail.asrEngine;
  const remoteAsr = asrEngine === "openai" || asrEngine === "remote" || asrEngine === "volcengine";

  const transcript = detail.transcript;
  const speakers = transcript?.speakers ?? [];
  const utterances = transcript?.utterances ?? [];
  const resolved = useMemo(
    () => (id: string) => resolveSpeakerName(speakers, id),
    [speakers],
  );
  // 当前播放命中的字幕行：最后一句 start <= 当前时间（且未到下一句开始）。
  const activeIndex = useMemo(() => {
    let last = -1;
    for (let i = 0; i < utterances.length; i++) {
      const u = utterances[i];
      if (u === undefined) continue;
      if (u.start <= t) last = i;
    }
    return last >= 0 ? last : null;
  }, [utterances, t]);

  const seek = useCallback((seconds: number) => {
    playerRef.current?.seek(seconds);
    setT(seconds);
  }, []);

  const rename = useCallback(
    async (speakerId: string, name: string) => {
      try {
        await window.vnote.renameSpeaker(detail.video.id, speakerId, name);
        await onRefresh();
        showToast(`说话人已改名为 ${name}`);
        return true;
      } catch (err) {
        showToast(`改名失败：${errMessage(err)}`);
        return false;
      }
    },
    [detail.video.id, onRefresh],
  );

  const merge = useCallback(
    async (speakerIds: string[], targetName: string) => {
      try {
        await window.vnote.mergeSpeakers(detail.video.id, speakerIds, targetName);
        await onRefresh();
        return true;
      } catch (err) {
        showToast(`合并失败：${errMessage(err)}`);
        return false;
      }
    },
    [detail.video.id, onRefresh],
  );

  const unmerge = useCallback(
    async (speakerId: string) => {
      try {
        await window.vnote.unmergeSpeaker(detail.video.id, speakerId);
        await onRefresh();
        showToast("已撤销合并");
        return true;
      } catch (err) {
        showToast(`撤销合并失败：${errMessage(err)}`);
        return false;
      }
    },
    [detail.video.id, onRefresh],
  );

  const rows = useMemo(
    () =>
      utterances.map((u) => {
        const sp = resolved(u.speakerId);
        return {
          index: u.index,
          start: u.start,
          text: u.text,
          speakerName: sp.name,
          speakerColor: sp.color,
        };
      }),
    [utterances, resolved],
  );

  const confirmRerun = () => {
    setRerunOpen(false);
    if (rerunScope === "topics") {
      void onRebuildTopics();
      showToast("已排队：仅重新生成主题 + 笔记");
    } else {
      void onRerunVideo();
      showToast("已排队：重新转写 + 主题 + 笔记");
    }
  };

  return (
    <>
      <Workspace
        title="字幕"
        actions={
          <button
            type="button"
            className="vn-btn primary"
            data-testid="transcript-to-topics"
            onClick={() => onPage("topics")}
          >
            开始主题分析 →
          </button>
        }
        detail={
          <>
            <Player
              ref={playerRef}
              mediaUrl={detail.mediaUrl}
              sourcePath={detail.playbackPath}
              onTime={setT}
            />
            {remoteAsr ? (
              <p className="vn-hint" style={{ marginTop: 14 }}>
                远程 ASR 不含说话人分离。
              </p>
            ) : null}
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
                <span>字幕（随播放自动滚动）</span>
                <span className="vn-hint">点击行定位</span>
              </div>
              <div style={{ padding: 14 }}>
                {rows.length > 0 ? (
                  <SubtitleList rows={rows} activeIndex={activeIndex} onSeek={seek} />
                ) : (
                  <div style={{ color: "var(--vn-muted)", fontSize: 12 }}>该视频没有结构化字幕</div>
                )}
              </div>
            </div>
          </>
        }
        aside={
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <SpeakerPanel speakers={speakers} onRename={rename} onMerge={merge} onUnmerge={unmerge} />
            <VideoGlossaryPanel videoId={detail.video.id} entries={detail.corrections} onSaved={onRefresh} />
            <button
              type="button"
              data-testid="rerun-scope-open"
              className="vn-btn sm"
              onClick={() => {
                setRerunScope("topics");
                setRerunOpen(true);
              }}
            >
              修改后选择重跑范围
            </button>
          </div>
        }
      />
      {rerunOpen ? createPortal(
        <div
          className="vn-mask"
          role="dialog"
          aria-modal="true"
          aria-label="选择重跑范围"
          onClick={(e) => {
            if (e.target === e.currentTarget) setRerunOpen(false);
          }}
        >
          <div className="vn-modal">
            <h2>选择重跑范围</h2>
            <p>
              受影响的视频：
              {detail.video.title}。
            </p>
            <div
              className={`vn-radio${rerunScope === "topics" ? " on" : ""}`}
              role="radio"
              aria-checked={rerunScope === "topics"}
              onClick={() => setRerunScope("topics")}
            >
              <div style={{ width: 16 }}>●</div>
              <div>
                <b>仅重新生成主题和笔记</b>
                <span>不重跑 ASR，约 40 秒。</span>
              </div>
            </div>
            <div
              className={`vn-radio${rerunScope === "asr" ? " on" : ""}`}
              role="radio"
              aria-checked={rerunScope === "asr"}
              onClick={() => setRerunScope("asr")}
            >
              <div style={{ width: 16 }}>○</div>
              <div>
                <b>连同语音重新转写</b>
                <span>术语作为 ASR 上下文，字幕、主题、笔记全部更新。</span>
              </div>
            </div>
            <div
              className="vn-row"
              style={{ justifyContent: "flex-end", marginTop: 18 }}
            >
              <button type="button" className="vn-btn" onClick={() => setRerunOpen(false)}>
                取消
              </button>
              <button
                type="button"
                data-testid="rerun-confirm"
                className="vn-btn primary"
                onClick={confirmRerun}
              >
                开始重跑
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
