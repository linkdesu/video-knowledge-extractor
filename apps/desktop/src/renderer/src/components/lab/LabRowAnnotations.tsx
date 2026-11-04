"use client";

import type { KeyboardEvent } from "react";
import { LAB_ISSUE_TYPES, LAB_MARK_LABEL, type LabMark, type LabSpeaker } from "../../../../shared/lab";
import type { LabRow } from "../../../../shared/lab-view";
import { Select } from "@/rbp/blocks/settings-form-3";

const LAB_VERDICTS = ["B", "A", "both"] as const;

/** 一行的两个人工事实：单选标记与实际说话人；字段由调用方独立合并落盘。 */
export function LabRowAnnotations({
  row,
  speakers,
  colorFor,
  onMark,
  onSpeaker,
}: {
  row: LabRow;
  speakers: LabSpeaker[];
  colorFor: (speakerId: string) => string;
  onMark: (mark: LabMark) => void;
  onSpeaker: (speaker: string | null) => void;
}) {
  const moveRadio = (e: KeyboardEvent<HTMLSpanElement>) => {
    const direction = e.key === "ArrowRight" || e.key === "ArrowDown"
      ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (direction === 0 || !(e.target instanceof HTMLButtonElement)) return;
    const options = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
    const current = options.indexOf(e.target);
    if (current === -1) return;
    e.preventDefault();
    e.stopPropagation();
    const next = options[(current + direction + options.length) % options.length];
    next?.focus();
    next?.click();
  };

  return (
    <div className="vn-lab-marks" onClick={(e) => e.stopPropagation()}>
      <span className="vn-lab-mark-radios" role="radiogroup" aria-label="行标记" onKeyDown={moveRadio}>
        <span className="vn-lab-mark-group" role="group" aria-label="谁对">
          <span className="vn-lab-mark-label" aria-hidden="true">谁对</span>
          {LAB_VERDICTS.map((mark) => (
            <button
              key={mark}
              type="button"
              className="vn-lab-mark"
              role="radio"
              aria-checked={row.mark === mark}
              aria-label={LAB_MARK_LABEL[mark]}
              tabIndex={row.mark === null ? (mark === "B" ? 0 : -1) : (row.mark === mark ? 0 : -1)}
              data-testid={`lab-mark-${mark}`}
              title={LAB_MARK_LABEL[mark]}
              onClick={() => onMark(mark)}
            >
              {LAB_MARK_LABEL[mark]}
            </button>
          ))}
        </span>
        <span className="vn-lab-mark-group" role="group" aria-label="问题类型">
          <span className="vn-lab-mark-label" aria-hidden="true">问题类型</span>
          {LAB_ISSUE_TYPES.map((issueType) => (
            <button
              key={issueType}
              type="button"
              className="vn-lab-mark"
              role="radio"
              aria-checked={row.mark === issueType}
              tabIndex={row.mark === issueType ? 0 : -1}
              data-testid={`lab-mark-${issueType}`}
              title={LAB_MARK_LABEL[issueType]}
              aria-label={LAB_MARK_LABEL[issueType]}
              onClick={() => onMark(issueType)}
            >
              {LAB_MARK_LABEL[issueType]}
            </button>
          ))}
        </span>
      </span>
      <span className="vn-lab-speaker-control">
        <span className="vn-lab-mark-label vn-lab-speaker-label" aria-hidden="true">实际说话人</span>
        <span className="vn-lab-speaker-select">
          {row.speaker === null ? null : (
            <span className="vn-lab-dot" style={{ background: colorFor(row.speaker) }} aria-hidden="true" />
          )}
          <Select
            value={row.speaker ?? ""}
            options={[
              { value: "", label: "未标注" },
              ...speakers.map((speaker) => ({ value: speaker.id, label: speaker.id })),
            ]}
            onChange={(value) => onSpeaker(value === "" ? null : value)}
            testId="lab-speaker-select"
            ariaLabel="实际说话人"
          />
        </span>
      </span>
    </div>
  );
}
