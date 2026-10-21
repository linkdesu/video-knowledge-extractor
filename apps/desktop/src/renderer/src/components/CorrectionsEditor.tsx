import { useEffect, useState } from "react";
import type { CorrectionEntry, VideoId } from "../../../shared/ipc";
import { errMessage } from "../lib/format";

type Props = {
  videoId: VideoId;
  initial: CorrectionEntry[];
  busy: boolean;
  onRerun: () => void;
};

// 纠错词表编辑器：表格增删行，保存后回显服务端状态；“保存并重跑”先保存再启动提取。
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
    <section className="corrections">
      <h3>纠错词表</h3>
      <div className="corrections__head">
        <span>识别错误</span>
        <span>→</span>
        <span>正确写法</span>
        <span />
      </div>
      {rows.length === 0 && <div className="corrections__empty">还没有词条，添加一条把识别错的词改成正确写法。</div>}
      {rows.map((row, i) => (
        <div className="corrections__row" key={i}>
          <input
            className="corrections__input"
            value={row.wrong}
            placeholder="原文"
            onChange={(e) => setCell(i, "wrong", e.target.value)}
          />
          <span className="corrections__arrow">→</span>
          <input
            className="corrections__input"
            value={row.right}
            placeholder="改写成"
            onChange={(e) => setCell(i, "right", e.target.value)}
          />
          <button type="button" className="corrections__del" onClick={() => removeRow(i)} aria-label="删除这一行">
            删
          </button>
        </div>
      ))}
      <button type="button" className="btn" onClick={addRow}>
        添加一行
      </button>
      {status !== null && <div className={`corrections__status ${status === "已保存" ? "" : "corrections__status--error"}`}>{status}</div>}
      <div className="corrections__actions">
        <button type="button" className="btn" onClick={() => void save(false)} disabled={working || busy}>
          保存
        </button>
        <button type="button" className="btn btn--primary" onClick={() => void save(true)} disabled={working || busy}>
          保存并重跑
        </button>
      </div>
    </section>
  );
}
