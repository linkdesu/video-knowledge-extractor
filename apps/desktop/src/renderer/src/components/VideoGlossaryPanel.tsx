"use client";

import { useRef, useState } from "react";
import type { CorrectionEntry } from "../../../shared/ipc";
import { VideoGlossaryPanel as GlossaryRows } from "../rbp/blocks/data-table-3";
import { errMessage } from "@/lib/format";
import { showToast } from "@/lib/toast";

type VideoGlossaryPanelProps = {
  videoId: string;
  /** 已落盘的纠错词条；作为初始行。 */
  entries: CorrectionEntry[];
  /** 保存成功后回调，通常接 onRefresh。 */
  onSaved?: () => Promise<void> | void;
};
 type Row = { key: number; entry: CorrectionEntry; local: boolean };

// 本视频专属术语表：两列（识别/正确）+ 新增/删除行，编辑即时 saveCorrections。
// 新增行先作为本地草稿（不落盘），两列都非空才保存一次。
//
// rows 用 { key, entry, local } 单数组：local 表示该行尚未落盘。
// 保存一次传的是「所有已落盘行 + 本次补全的行」，其余仍空的草稿行不进请求。
export function VideoGlossaryPanel({ videoId, entries, onSaved }: VideoGlossaryPanelProps) {
  const [rows, setRows] = useState<Row[]>(() =>
    entries.map((e, i) => ({ key: i, entry: { ...e }, local: false })),
  );
  const nextKey = useRef(entries.length);
  // 每个 key 最近一次成功落盘的值；保存失败时回滚到它而不是可能过期的乐观值。
  const lastSaved = useRef<Map<number, CorrectionEntry>>(
    new Map(entries.map((e, i) => [i, { ...e }])),
  );

  // saveKeys 指定要落盘的 key；list 传所有需要保存的当前值。
  // 失败回滚到 lastSaved（最近一次成功落盘），而不是可能过期的乐观值。
  const persist = (nextRows: Row[], saveKeys: Set<number>) => {
    const list = nextRows.filter((r) => saveKeys.has(r.key)).map((r) => r.entry);
    const old = new Map<number, CorrectionEntry>();
    rows.forEach((r) => {
      if (saveKeys.has(r.key)) old.set(r.key, { ...r.entry });
    });
    void window.vnote
      .saveCorrections(videoId, list)
      .then(() => {
        const stamp = new Date().toISOString();
        setRows((prev) =>
          prev.map((r) => {
            if (!saveKeys.has(r.key)) return r;
            const entry = { ...r.entry, updatedAt: stamp };
            lastSaved.current.set(r.key, entry);
            return { ...r, entry, local: false };
          }),
        );
        showToast("已保存到本视频");
        void onSaved?.();
      })
      .catch((err) => {
        showToast(`保存失败：${errMessage(err)}`);
        setRows((prev) =>
          prev.map((r) => {
            if (!saveKeys.has(r.key)) return r;
            const o = lastSaved.current.get(r.key) ?? old.get(r.key);
            return o ? { ...r, entry: { ...o } } : r;
          }),
        );
      });
  };

  const editCell = (index: number, key: "wrong" | "right", value: string) => {
    const target = rows[index];
    if (target === undefined) return;
    const updatedEntry = { ...target.entry, [key]: value };
    const complete = updatedEntry.wrong.trim() !== "" && updatedEntry.right.trim() !== "";
    let nextRows = rows.map((r, i) => (i === index ? { ...r, entry: updatedEntry } : r));
    let saveKeys: Set<number> | null = null;
    if (!target.local) {
      // 已落盘行：改动即时保存，保存所有非草稿行。
      saveKeys = new Set(nextRows.filter((r) => !r.local).map((r) => r.key));
    } else if (complete) {
      // 草稿行补全：保存所有非草稿行 + 这一行，并把这一行标记为非草稿。
      saveKeys = new Set(nextRows.filter((r) => !r.local).map((r) => r.key));
      saveKeys.add(target.key);
      nextRows = nextRows.map((r, i) => (i === index ? { ...r, local: false } : r));
    }
    // 否则（草稿行仍空）：只改本地，不保存。
    setRows(nextRows);
    if (saveKeys !== null) persist(nextRows, saveKeys);
  };

  const removeRow = (index: number) => {
    const target = rows[index];
    if (target === undefined) return;
    const nextRows = rows.filter((_, i) => i !== index);
    setRows(nextRows);
    if (target.local) return; // 草稿行删除只动本地，不产生保存。
    persist(nextRows, new Set(nextRows.filter((r) => !r.local).map((r) => r.key)));
  };

  const addRow = () => {
    const entry: CorrectionEntry = {
      wrong: "",
      right: "",
      source: "manual",
      updatedAt: null,
    };
    const key = nextKey.current++;
    setRows((prev) => [...prev, { key, entry, local: true }]);
  };

  return (
    <GlossaryRows
      rows={rows.map((r) => r.entry)}
      onEditCell={editCell}
      onRemoveRow={removeRow}
      onAddRow={addRow}
    />
  );
}
