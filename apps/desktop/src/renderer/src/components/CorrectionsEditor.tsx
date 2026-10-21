import { useEffect, useState } from "react";
import type { CorrectionEntry, VideoId } from "../../../shared/ipc";
import { errMessage } from "../lib/format";
import { CorrectionsTable } from "../rbp/blocks/data-table-3";

type Props = {
  videoId: VideoId;
  initial: CorrectionEntry[];
  busy: boolean;
  onRerun: () => void;
};

// 纠错词表编辑器：状态与 IPC 在这层，表格只做展示与输入。
export function CorrectionsEditor({ videoId, initial, busy, onRerun }: Props) {
  const [rows, setRows] = useState<CorrectionEntry[]>(initial);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // detail 每次重新拉取都是新数组，直接以服务端状态为准。
  useEffect(() => {
    setRows(initial);
  }, [initial]);

  const setCell = (index: number, key: keyof CorrectionEntry, value: string) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  };

  const removeRow = (index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  };

  const addRow = () => {
    setRows((prev) => [...prev, { wrong: "", right: "" }]);
  };

  const save = async (andRerun: boolean) => {
    setWorking(true);
    setStatus(null);
    try {
      const saved = await window.vnote.saveCorrections(videoId, rows);
      setRows(saved);
      setStatus("已保存");
      if (andRerun) onRerun();
    } catch (err) {
      setStatus(errMessage(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <CorrectionsTable
      rows={rows}
      busy={working || busy}
      status={status}
      onEditCell={setCell}
      onRemoveRow={removeRow}
      onAddRow={addRow}
      onSave={(andRerun) => void save(andRerun)}
    />
  );
}
