"use client";

import { useState } from "react";
import type { SpeakerInfo } from "../../../shared/ipc";
import { showToast } from "@/lib/toast";
import { errMessage } from "@/lib/format";

type SpeakerPanelProps = {
  /** 说话人列表；只渲染顶层说话人（`mergedInto` 为空），id 用于 rename/merge 调用，界面只显示姓名。 */
  speakers: SpeakerInfo[];
  /** 改名落盘；返回 false 表示失败，输入框回滚。 */
  onRename: (speakerId: string, name: string) => Promise<boolean>;
  /** 合并选中的顶层说话人（第一个为目标）；返回 false 表示失败。 */
  onMerge: (speakerIds: string[], targetName: string) => Promise<boolean>;
  /** 撤销一次合并；返回 false 表示失败。 */
  onUnmerge: (speakerId: string) => Promise<boolean>;
};

function Row({
  speaker,
  onRename,
  checked,
  onChecked,
  hasMembers,
  onUnmerge,
}: {
  speaker: SpeakerInfo;
  onRename: SpeakerPanelProps["onRename"];
  checked: boolean;
  onChecked: (v: boolean) => void;
  hasMembers: boolean;
  onUnmerge: SpeakerPanelProps["onUnmerge"];
}) {
  const [draft, setDraft] = useState(speaker.name);

  const commit = () => {
    const name = draft.trim();
    if (name === "" || name === speaker.name) {
      setDraft(speaker.name);
      return;
    }
    void onRename(speaker.id, name).then((ok) => {
      if (!ok) setDraft(speaker.name);
    });
  };

  const unmerge = () => {
    void onUnmerge(speaker.id).then((ok) => {
      if (!ok) showToast("撤销合并失败");
    });
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "18px 26px 1fr",
        gap: 10,
        alignItems: "center",
        padding: "7px 14px",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChecked(e.target.checked)}
        aria-label={`选择说话人 ${speaker.name}`}
      />
      <span
        aria-label={`说话人 ${speaker.name}`}
        style={{
          width: 18,
          height: 18,
          borderRadius: 6,
          background: speaker.color,
        }}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          aria-label={`重命名说话人 ${speaker.name}`}
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid var(--vn-line)",
            borderRadius: 8,
            padding: "5px 8px",
            color: "var(--vn-fg)",
            fontSize: 12,
            width: "100%",
            outline: "none",
          }}
        />
        {hasMembers ? (
          <button type="button" className="vn-btn" data-testid="speaker-unmerge" onClick={unmerge}>
            撤销合并
          </button>
        ) : null}
      </div>
    </div>
  );
}

// 说话人面板：顶层说话人列表（每行一个勾选框），≥2 个选中时启用「合并说话人」；
// 合并后成员行保留原名/原色，存活者行出现「撤销合并」。
export function SpeakerPanel({ speakers, onRename, onMerge, onUnmerge }: SpeakerPanelProps) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [targetName, setTargetName] = useState("");
  const [busy, setBusy] = useState(false);

  const top = speakers.filter((s) => s.mergedInto === null);
  const membersOf = (id: string) => speakers.some((s) => s.mergedInto === id);
  const canMerge = picked.size >= 2;

  const openConfirm = () => {
    // 默认目标名：第一个自定义过的选中者，否则按勾选顺序第一个。
    const ordered = top.filter((s) => picked.has(s.id));
    const def =
      ordered.find((s) => s.customName)?.name ?? ordered[0]?.name ?? "";
    setTargetName(def);
    setConfirming(true);
  };

  const doMerge = async () => {
    const name = targetName.trim();
    if (name === "") return;
    const ids = top.filter((s) => picked.has(s.id)).map((s) => s.id);
    setBusy(true);
    const ok = await onMerge(ids, name);
    setBusy(false);
    if (ok) {
      setPicked(new Set());
      setConfirming(false);
      showToast(`已合并为 ${name}`);
    }
  };

  return (
    <div className="vn-card" data-testid="speaker-panel">
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
        <span>说话人</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            className="vn-btn"
            data-testid="speaker-merge"
            disabled={!canMerge}
            onClick={openConfirm}
          >
            合并说话人
          </button>
          <span className="vn-hint">改名即时同步字幕</span>
        </div>
      </div>
      {top.map((s) => (
        <Row
          key={s.id}
          speaker={s}
          onRename={onRename}
          checked={picked.has(s.id)}
          onChecked={(v) =>
            setPicked((prev) => {
              const next = new Set(prev);
              if (v) next.add(s.id);
              else next.delete(s.id);
              return next;
            })
          }
          hasMembers={membersOf(s.id)}
          onUnmerge={onUnmerge}
        />
      ))}
      {confirming ? (
        <div className="vn-mask" role="dialog" aria-modal="true" aria-label="合并说话人">
          <div className="vn-modal" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <h3 style={{ margin: 0 }}>合并说话人</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "var(--vn-muted)" }}>
              合并后的名字
              <input
                value={targetName}
                onChange={(e) => setTargetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && targetName.trim() !== "") void doMerge();
                }}
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid var(--vn-line)",
                  borderRadius: 8,
                  padding: "6px 10px",
                  color: "var(--vn-fg)",
                  fontSize: 12,
                  outline: "none",
                }}
              />
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="vn-btn" onClick={() => setConfirming(false)}>
                取消
              </button>
              <button
                type="button"
                className="vn-btn primary"
                data-testid="speaker-merge-confirm"
                disabled={busy || targetName.trim() === ""}
                onClick={() => void doMerge()}
              >
                确认合并
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
