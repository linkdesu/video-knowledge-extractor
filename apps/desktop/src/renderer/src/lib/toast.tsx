import { useEffect, useState } from "react";

type ToastItem = { id: number; message: string; kind: "info" | "error" };

type PushFn = (message: string, kind: "info" | "error") => void;

// 调用方漏标 kind 时的兜底：按文案判断是否为错误，保证错误提示不会被自动消失吞掉
const ERROR_HINT = /失败|错误|未配置|未就绪|Error/i;

let push: PushFn | undefined;
let seq = 0;

export function showToast(message: string, opts?: { kind?: "info" | "error" }): void {
  push?.(message, opts?.kind ?? (ERROR_HINT.test(message) ? "error" : "info"));
}

export function showErrorToast(message: string): void {
  push?.(message, "error");
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    push = (message, kind) => {
      const item = { id: ++seq, message, kind };
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
