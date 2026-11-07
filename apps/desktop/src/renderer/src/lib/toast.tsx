import { useEffect, useState } from "react";

type ToastAction = { label: string; onClick: () => void };
type ToastItem = { id: number; message: string; kind: "info" | "error"; action?: ToastAction };

type PushFn = (message: string, kind: "info" | "error", action?: ToastAction) => void;

// 调用方漏标 kind 时的兜底：按文案判断是否为错误，保证错误提示不会被自动消失吞掉
const ERROR_HINT = /失败|错误|未配置|未就绪|Error/i;

let push: PushFn | undefined;
let seq = 0;

export function showToast(message: string, opts?: { kind?: "info" | "error"; action?: ToastAction }): void {
  push?.(message, opts?.kind ?? (ERROR_HINT.test(message) ? "error" : "info"), opts?.action);
}

export function showErrorToast(message: string, action?: ToastAction): void {
  push?.(message, "error", action);
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    push = (message, kind, action) => {
      const item = { id: ++seq, message, kind, ...(action !== undefined ? { action } : {}) };
      setItems((prev) => [...prev, item]);
      // 错误提示常驻，由用户手动关闭
      if (kind === "info") {
        setTimeout(() => {
          setItems((prev) => prev.filter((t) => t.id !== item.id));
        }, 2400);
      }
    };
    return () => {
      push = undefined;
    };
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="vn-toast" data-testid="toast-host">
      {items.map((t) => (
        <div
          key={t.id}
          data-kind={t.kind}
          style={{ display: "flex", alignItems: "flex-start", gap: 8 }}
        >
          <div style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {t.message}
          </div>
          {t.action !== undefined ? (
            <button
              type="button"
              data-testid="toast-action"
              className="vn-btn sm primary"
              style={{ flexShrink: 0 }}
              onClick={() => {
                t.action?.onClick();
                setItems((prev) => prev.filter((x) => x.id !== t.id));
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="toast-close"
            className="vn-btn sm"
            style={{ flexShrink: 0 }}
            onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
          >
            关闭
          </button>
        </div>
      ))}
    </div>
  );
}
