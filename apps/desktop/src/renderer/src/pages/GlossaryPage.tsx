import { useCallback, useEffect, useRef, useState } from "react";
import type { CorrectionEntry } from "../../../shared/ipc";
import { createGlossarySaveScheduler, type GlossarySaveScheduler } from "../../../shared/glossary-save";
import { GlossaryTable } from "../rbp/blocks/data-table-3";
import { errMessage } from "../lib/format";
import { showToast } from "../lib/toast";

/** 编辑后停手这么久才落盘；删除行与离开页面立即保存。 */
const SAVE_DEBOUNCE_MS = 400;

export function GlossaryPage() {
  const [rows, setRows] = useState<CorrectionEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 草稿放在 ref 里，调度器到点读最新值，不受 React 渲染时机影响。
  const rowsRef = useRef<CorrectionEntry[]>([]);
  const schedulerRef = useRef<GlossarySaveScheduler | null>(null);

  const apply = (next: CorrectionEntry[]) => {
    rowsRef.current = next;
    setRows(next);
  };

  const reload = useCallback(() => {
    schedulerRef.current?.dispose();
    schedulerRef.current = null;
    setRows(null);
    setLoadError(null);
    window.vnote
      .listGlossary()
      .then((loaded) => {
        apply(loaded);
        schedulerRef.current = createGlossarySaveScheduler({
          delayMs: SAVE_DEBOUNCE_MS,
          initial: loaded,
          snapshot: () => rowsRef.current,
          save: (entries) => window.vnote.saveGlossary(entries),
          onError: (err) => showToast(`保存失败：${errMessage(err)}`),
        });
      })
      .catch((err) => setLoadError(errMessage(err)));
  }, []);

  useEffect(() => {
    reload();
    return () => {
      // 离开页面时补存最后一次编辑；不 dispose，让进行中的保存落地后再补存一次。
      schedulerRef.current?.flush();
      schedulerRef.current = null;
    };
  }, [reload]);

  const editCell = (index: number, key: "wrong" | "right", value: string) => {
    apply(rowsRef.current.map((e, i) => (i === index ? { ...e, [key]: value } : e)));
    schedulerRef.current?.schedule();
  };

  const removeRow = (index: number) => {
    apply(rowsRef.current.filter((_, i) => i !== index));
    schedulerRef.current?.flush();
  };

  const addRow = () => {
    apply([
      ...rowsRef.current,
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
            全局术语，填完两列后自动保存；视频专属术语在视频库详情中编辑。
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
