import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ProjectSubtitleLineInfo } from "../../../shared/ipc";
import {
  canGenerate,
  lineTimeLabel,
  selectedCountLabel,
  suggestedSelection,
  toggleLine,
  visibleSelection,
} from "../lib/topic-confirm";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 单主题确认字幕弹窗（#143，原型 L82 / L137-L139 / L152）：
 * 标题是当前主题；展示来源视频当前已知完整字幕，AI 建议行默认勾选；
 * 可勾选补入、取消移除；底部只有「生成切片」「稍后确认」。
 * 关闭（Esc / 稍后确认）由父层卸载本组件，重开按 AI 建议重新初始化。
 */
export function TopicConfirmDialog({
  topic,
  sourceLine,
  lines,
  onDefer,
  onGenerate,
  loading = false,
  loadError = null,
}: {
  topic: { topicKey: string; title: string; lineIds: string[] };
  /** 弹窗副标题（来源文件 · 分析区间）；与待确认列表行的来源行不是同一段文案。 */
  sourceLine: string;
  lines: ProjectSubtitleLineInfo[];
  onDefer: () => void;
  onGenerate: (lineIds: string[]) => Promise<void>;
  /** 字幕读取中与「真的没有字幕」必须分开，否则 0/0 会假装空选。 */
  loading?: boolean;
  loadError?: string | null;
}): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<string[]>(() => suggestedSelection(topic));
  const [submitting, setSubmitting] = useState(false);
  /**
   * 只认当前字幕里真实存在的行：分析完成后来源字幕可能被删改，AI 建议指向的 id 会失效，
   * 否则界面会显示「已选 N 行 / 完整字幕 0 行」并允许提交，直到主进程报「所选字幕为空」。
   */
  const selectedIds = visibleSelection(selected, lines);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // 提交时所有控件都被禁用，焦点会掉到 body、Tab 就能溜到背景界面：先收回弹窗容器
  useEffect(() => {
    if (submitting) dialogRef.current?.focus();
  }, [submitting]);

  /**
   * `aria-modal` 要真的隔离焦点：遮罩只挡指针，脚本、错误 toast 的按钮、背景残留的
   * autofocus 都能把焦点挪出 portal，之后 Tab 就不再经过弹窗内的循环。
   * toast 在遮罩之上，是唯一允许暂时接管的元素；焦点一旦落到其它背景元素就拉回弹窗。
   */
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

  /**
   * Esc 挂在 window 上而不是遮罩：焦点恢复或用户用键盘切走时，键盘事件不再经过遮罩，
   * 原生 `<dialog>` 的 Esc 语义仍然是「只关弹窗、不提交」。
   */
  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onDefer();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [onDefer]);

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

  const generateDisabled = loading || loadError !== null || submitting || !canGenerate(selectedIds);

  const generate = async () => {
    if (generateDisabled) return;
    setSubmitting(true);
    try {
      await onGenerate(selectedIds);
    } catch {
      // 父层已经提示失败；保留弹窗与当前勾选，允许修正后重试。
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      ref={dialogRef}
      className="vn-mask vn-topic-confirm-mask"
      data-testid="topic-confirm-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="topic-confirm-title"
      aria-describedby="topic-confirm-description"
      aria-busy={loading}
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
    >
      <div className="vn-modal vn-topic-confirm">
        <div className="vn-topic-confirm-head">
          <h2 id="topic-confirm-title" data-testid="topic-confirm-title">
            {topic.title}
          </h2>
          <p data-testid="topic-confirm-source">{sourceLine}</p>
        </div>
        <p id="topic-confirm-description" className="vn-topic-confirm-description">
          当前只编辑这一个主题。下方展示来源视频当前已知的完整字幕；勾选可补入 AI
          漏选的行，取消勾选可移除不需要的行。选中字幕按时间顺序拼接，不包含中间未选内容。
        </p>
        {loading || loadError !== null ? null : (
          <p className="vn-topic-confirm-summary" data-testid="topic-confirm-summary">
            {selectedCountLabel(selectedIds.length, lines.length)}
          </p>
        )}
        <div
          className="vn-topic-confirm-lines"
          data-testid="topic-confirm-lines"
          role="group"
          aria-label="完整字幕"
        >
          {loading ? (
            <p className="vn-topic-confirm-state" data-testid="topic-confirm-loading" role="status">
              正在读取完整字幕…
            </p>
          ) : loadError !== null ? (
            <p className="vn-topic-confirm-state error" data-testid="topic-confirm-error" role="alert">
              {loadError}
            </p>
          ) : (
            lines.map((line) => {
              const time = lineTimeLabel(line);
              return (
                <label
                  key={line.id}
                  className="vn-topic-line"
                  data-testid="topic-line"
                  data-line-id={line.id}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(line.id)}
                    disabled={submitting}
                    aria-label={[time, line.speaker, line.text]
                      .filter((part) => part !== "")
                      .join(" ")}
                    onChange={() => setSelected((current) => toggleLine(current, line.id))}
                  />
                  <time data-testid="topic-line-time">{time}</time>
                  <span className="vn-topic-line-speaker" data-testid="topic-line-speaker">
                    {line.speaker}
                  </span>
                  <span className="vn-topic-line-text" data-testid="topic-line-text">
                    {line.text}
                  </span>
                </label>
              );
            })
          )}
        </div>
        <div className="vn-topic-confirm-actions">
          <button
            type="button"
            className="vn-btn primary"
            data-testid="topic-confirm-generate"
            disabled={generateDisabled}
            onClick={() => void generate()}
          >
            生成切片
          </button>
          <button
            type="button"
            className="vn-btn"
            data-testid="topic-confirm-defer"
            disabled={submitting}
            onClick={onDefer}
          >
            稍后确认
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
