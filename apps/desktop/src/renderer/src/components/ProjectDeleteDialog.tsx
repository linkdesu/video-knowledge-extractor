import { useEffect, useRef, type JSX, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ProjectSummary } from "../../../shared/ipc";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 删除项目登记前的后果确认；文件系统不变，进行中的项目任务会停止。 */
export function ProjectDeleteDialog({
  project,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  project: ProjectSummary;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // 删除中两个按钮都不可用，先把焦点收回容器，避免 Tab 落到背景界面。
  useEffect(() => {
    if (busy) dialogRef.current?.focus();
  }, [busy]);

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      const target = event.target;
      if (dialog === null || !(target instanceof Node) || dialog.contains(target)) return;
      if (target instanceof Element && target.closest('[data-testid="toast-host"]') !== null) return;
      dialog.focus();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [busy, onCancel]);

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === dialogRef.current)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      ref={dialogRef}
      className="vn-mask"
      data-testid="project-delete-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-delete-title"
      aria-describedby="project-delete-consequences"
      aria-busy={busy}
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="vn-modal vn-project-delete-modal">
        <h2 id="project-delete-title">删除项目「{project.name}」？</h2>
        <ul id="project-delete-consequences" className="vn-project-delete-consequences">
          <li>只从项目列表移除这条登记。</li>
          <li>项目目录、监控目录里的源视频，以及项目切片目录里已生成的切片都不会改动。</li>
          <li>该项目正在进行的监控、分析和切片任务会立即停止。</li>
        </ul>
        {error !== null ? (
          <p
            className="vn-project-error vn-project-delete-error"
            data-testid="project-delete-error"
            role="alert"
          >
            删除失败：{error}
          </p>
        ) : null}
        <div className="vn-project-delete-actions">
          <button
            type="button"
            className="vn-btn"
            data-testid="project-delete-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="vn-btn danger"
            data-testid="project-delete-confirm"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "删除中…" : "确认删除"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
