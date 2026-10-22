"use client";

import type { CorrectionEntry } from "../../../../shared/ipc";
import { fmtDateTime } from "@/lib/format";

// data-table-3 改造：术语表行原语。五列（识别结果/正确写法/来源/修改时间/操作），
// 行内编辑、新增行、删除行、自动保存；演示表头/表脚逻辑已删除。

type Props = {
  rows: CorrectionEntry[];
  onEditCell: (index: number, key: "wrong" | "right", value: string) => void;
  onRemoveRow: (index: number) => void;
  onAddRow: () => void;
};

const input =
  "w-full min-w-0 cursor-text rounded-[8px] border border-[var(--vn-line)] bg-[rgba(255,255,255,0.04)] px-2 py-1 text-[12px] text-[var(--vn-fg)] outline-none focus:border-[rgba(139,92,246,0.6)]";

export function GlossaryTable({ rows, onEditCell, onRemoveRow, onAddRow }: Props) {
  return (
    <div className="vn-card" style={{ overflow: "hidden" }}>
      <table className="vn-table">
        <thead>
          <tr>
            <th scope="col">识别结果</th>
            <th scope="col">正确写法</th>
            <th scope="col">来源</th>
            <th scope="col">修改时间</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} data-testid="glossary-row">
              <td style={{ minWidth: 160 }}>
                <input
                  className={input}
                  value={row.wrong}
                  placeholder="识别出的词"
                  aria-label={`第 ${i + 1} 行识别结果`}
                  data-testid="glossary-wrong"
                  onChange={(e) => onEditCell(i, "wrong", e.target.value)}
                />
              </td>
              <td style={{ minWidth: 160 }}>
                <input
                  className={input}
                  value={row.right}
                  placeholder="正确写法"
                  aria-label={`第 ${i + 1} 行正确写法`}
                  data-testid="glossary-right"
                  onChange={(e) => onEditCell(i, "right", e.target.value)}
                />
              </td>
              <td>{row.source === null ? "手工" : row.source === "manual" ? "手工" : "从字幕添加"}</td>
              <td>{fmtDateTime(row.updatedAt)}</td>
              <td style={{ width: 1, whiteSpace: "nowrap" }}>
                <button
                  type="button"
                  className="vn-btn sm"
                  aria-label={`删除第 ${i + 1} 行：${row.wrong} → ${row.right}`}
                  data-testid="glossary-remove"
                  onClick={() => onRemoveRow(i)}
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function VideoGlossaryPanel({
  rows,
  onEditCell,
  onRemoveRow,
  onAddRow,
}: {
  rows: Array<{ wrong: string; right: string }>;
  onEditCell: (index: number, key: "wrong" | "right", value: string) => void;
  onRemoveRow: (index: number) => void;
  onAddRow: () => void;
}) {
  return (
    <div className="vn-card" data-testid="video-glossary">
      <div className="vn-gloss-hd">
        <span>本视频专属术语表</span>
        <button
          type="button"
          className="vn-btn sm"
          onClick={onAddRow}
          data-testid="video-glossary-add"
        >
          ＋ 新增
        </button>
      </div>
      {rows.map((row, i) => (
        <div key={i} className="vn-gloss-row" data-testid="video-glossary-row">
          <input
            value={row.wrong}
            aria-label={`第 ${i + 1} 行识别结果`}
            data-testid="video-glossary-wrong"
            onChange={(e) => onEditCell(i, "wrong", e.target.value)}
          />
          <input
            value={row.right}
            aria-label={`第 ${i + 1} 行正确写法`}
            data-testid="video-glossary-right"
            onChange={(e) => onEditCell(i, "right", e.target.value)}
          />
          <span
            className="vn-gloss-x"
            role="button"
            tabIndex={0}
            aria-label="删除这一行"
            data-testid="video-glossary-remove"
            onClick={() => onRemoveRow(i)}
          >
            ×
          </span>
        </div>
      ))}
      <div className="vn-hint" style={{ padding: "8px 14px 12px" }}>
        编辑即保存；只作用于当前视频。
      </div>
    </div>
  );
}
