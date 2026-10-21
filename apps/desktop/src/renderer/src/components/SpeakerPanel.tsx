"use client";

import { useState } from "react";
import type { SpeakerInfo } from "../../../shared/ipc";

type SpeakerPanelProps = {
  /** 说话人列表；id 仅用于 renameSpeaker 调用，界面只显示姓名。 */
  speakers: SpeakerInfo[];
  /** 改名落盘；返回 false 表示失败，输入框回滚。 */
  onRename: (speakerId: string, name: string) => Promise<boolean>;
};

function Row({ speaker, onRename }: { speaker: SpeakerInfo; onRename: SpeakerPanelProps["onRename"] }) {
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

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "26px 1fr",
        gap: 10,
        alignItems: "center",
        padding: "7px 14px",
      }}
    >
      <span
        aria-label={`说话人 ${speaker.name}`}
        style={{
          width: 18,
          height: 18,
          borderRadius: 6,
          background: speaker.color,
        }}
      />
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
    </div>
  );
}

// 说话人面板：只有颜色点与姓名输入框，不显示说话人编号。
export function SpeakerPanel({ speakers, onRename }: SpeakerPanelProps) {
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
        <span className="vn-hint">改名即时同步字幕</span>
      </div>
      {speakers.map((s) => (
        <Row key={s.id} speaker={s} onRename={onRename} />
      ))}
    </div>
  );
}
