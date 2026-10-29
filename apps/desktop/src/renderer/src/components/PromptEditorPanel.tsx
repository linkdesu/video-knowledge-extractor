import { useEffect, useState } from "react";
import type { PromptStatus } from "../../../shared/ipc";
import { errMessage } from "../lib/format";
import { Button } from "../rbp/blocks/settings-form-3";

type EditorState = {
  draft: string;
  dirty: boolean;
  saving: boolean;
  resetting: boolean;
  message: string | null;
  error: boolean;
};

function PromptStepEditor({
  status,
  onStatusesChange,
}: {
  status: PromptStatus;
  onStatusesChange: (statuses: PromptStatus[]) => void;
}) {
  const [editor, setEditor] = useState<EditorState>({
    draft: status.value,
    dirty: false,
    saving: false,
    resetting: false,
    message: null,
    error: false,
  });

  useEffect(() => {
    setEditor((current) =>
      current.dirty || current.saving || current.resetting
        ? current
        : { ...current, draft: status.value },
    );
  }, [status.id, status.value]);

  const save = async () => {
    if (editor.saving || editor.resetting || editor.draft === status.value) return;
    const atSave = editor.draft;
    setEditor((current) => ({ ...current, saving: true, message: null, error: false }));
    try {
      const next = await window.vnote.savePrompt(status.id, atSave);
      const saved = next.find((item) => item.id === status.id);
      if (saved === undefined) throw new Error("保存后未找到该提示词");
      onStatusesChange(next);
      setEditor((current) => {
        const untouched = current.draft === atSave;
        return {
          ...current,
          draft: untouched ? saved.value : current.draft,
          dirty: untouched ? false : current.dirty,
          saving: false,
          message: untouched ? "已保存" : current.message,
          error: false,
        };
      });
    } catch (err) {
      setEditor((current) => ({
        ...current,
        saving: false,
        message: errMessage(err),
        error: true,
      }));
    }
  };

  const reset = async () => {
    if (!status.customized || editor.saving || editor.resetting) return;
    const atReset = editor.draft;
    setEditor((current) => ({ ...current, resetting: true, message: null, error: false }));
    try {
      const next = await window.vnote.resetPrompt(status.id);
      const restored = next.find((item) => item.id === status.id);
      if (restored === undefined) throw new Error("恢复默认后未找到该提示词");
      onStatusesChange(next);
      setEditor((current) => {
        const untouched = current.draft === atReset;
        return {
          ...current,
          draft: untouched ? restored.value : current.draft,
          dirty: untouched ? false : current.dirty,
          resetting: false,
          message: untouched ? "已恢复默认" : current.message,
          error: false,
        };
      });
    } catch (err) {
      setEditor((current) => ({
        ...current,
        resetting: false,
        message: errMessage(err),
        error: true,
      }));
    }
  };

  const editorId = `prompt-editor-${status.id}`;
  const busy = editor.saving || editor.resetting;

  return (
    <section className="vn-prompt-step" data-testid={`prompt-card-${status.id}`}>
      <div className="vn-prompt-heading">
        <strong>{status.title}</strong>
        {status.customized ? <span className="vn-tag accent">已自定义</span> : null}
      </div>
      <p className="vn-hint vn-prompt-description">{status.description}</p>
      <div className="vn-prompt-vars">
        {status.variables.map((variable) => (
          <span
            className="vn-tag"
            data-testid={`prompt-var-${status.id}-${variable.name}`}
            title={variable.description}
            key={variable.name}
          >
            {`{{${variable.name}}}`}
          </span>
        ))}
      </div>
      <p className="vn-sr-only">
        可用变量：{status.variables.map((variable) => `{{${variable.name}}}`).join("、")}
      </p>
      <label className="vn-prompt-label" htmlFor={editorId}>
        提示词模板
      </label>
      <textarea
        id={editorId}
        className="vn-prompt-editor"
        data-testid={editorId}
        aria-label={`编辑提示词 ${status.title}`}
        value={editor.draft}
        disabled={editor.resetting}
        onChange={(event) => {
          const draft = event.target.value;
          setEditor((current) => ({
            ...current,
            draft,
            dirty: draft !== status.value,
            message: null,
            error: false,
          }));
        }}
      />
      <div className="vn-prompt-actions">
        <Button
          type="button"
          variant="primary"
          size="sm"
          data-testid={`prompt-save-${status.id}`}
          disabled={editor.draft === status.value || busy}
          onClick={save}
        >
          {editor.saving ? "保存中…" : "保存"}
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid={`prompt-reset-${status.id}`}
          disabled={!status.customized || busy}
          onClick={reset}
        >
          {editor.resetting ? "恢复中…" : "恢复默认"}
        </Button>
        <span
          className={`vn-prompt-status${editor.error ? " error" : ""}`}
          data-testid={`prompt-status-${status.id}`}
          aria-live="polite"
        >
          {editor.message}
        </span>
      </div>
    </section>
  );
}

export function PromptEditorPanel({
  statuses,
  onStatusesChange,
}: {
  statuses: PromptStatus[];
  onStatusesChange: (statuses: PromptStatus[]) => void;
}) {
  return (
    <div className="vn-prompt-list">
      {statuses.map((status) => (
        <PromptStepEditor status={status} onStatusesChange={onStatusesChange} key={status.id} />
      ))}
    </div>
  );
}
