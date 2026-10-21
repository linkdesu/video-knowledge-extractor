import { useEffect, useState } from "react";
import type { CorrectionEntry } from "../../../shared/ipc";
import { GlossaryTable } from "../rbp/blocks/data-table-3";
import { errMessage } from "../lib/format";
import { showToast } from "../lib/toast";

export function GlossaryPage() {
  const [rows, setRows] = useState<CorrectionEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = () => {
    setRows(null);
    setLoadError(null);
    window.vnote
      .listGlossary()
      .then(setRows)
      .catch((err) => setLoadError(errMessage(err)));
  };

  useEffect(reload, []);

  const save = (next: CorrectionEntry[]) => {
    setRows(next);
    window.vnote
      .saveGlossary(next)
      .then((saved) => {
        setRows(saved);
        showToast("已即时保存");
      })
      .catch((err) => showToast(`保存失败：${errMessage(err)}`));
  };

  const editCell = (index: number, key: "wrong" | "right", value: string) => {
    if (rows === null) return;
    save(rows.map((e, i) => (i === index ? { ...e, [key]: value } : e)));
  };

  const removeRow = (index: number) => {
    if (rows === null) return;
    save(rows.filter((_, i) => i !== index));
  };

  const addRow = () => {
    if (rows === null) return;
    save([
      ...rows,
      {
        wrong: "",
        right: "",
        source: "manual",
        updatedAt: new Date().toISOString(),
      },
    ]);
  };

  return (
    <>
      <div className="vn-row vn-between" style={{ marginBottom: 14 }}>
        <div>
          <h1 className="vn-h1" style={{ marginBottom: 0 }}>
            术语表
          </h1>
          <p className="vn-sub" style={{ marginBottom: 0 }}>
            全局术语，编辑后即时保存；视频专属术语在视频库详情中编辑。
          </p>
        </div>
        <button
          type="button"
          data-testid="glossary-add"
          className="vn-btn sm"
          onClick={addRow}
          disabled={rows === null}
        >
          ＋ 新增词条
        </button>
      </div>

      {loadError !== null ? (
        <div className="vn-hint">
          加载术语表失败：{loadError}
          <button
            type="button"
            className="vn-btn sm"
            style={{ marginLeft: 12 }}
            onClick={reload}
          >
            重试
          </button>
        </div>
      ) : rows === null ? (
        <div className="vn-hint">加载术语表中…</div>
      ) : (
        <GlossaryTable
          rows={rows}
          onEditCell={editCell}
          onRemoveRow={removeRow}
          onAddRow={addRow}
        />
      )}
    </>
  );
}
