import { useEffect, useState } from "react";

type ToastItem = { id: number; message: string };

type PushFn = (message: string) => void;

let push: PushFn | undefined;
let seq = 0;

export function showToast(message: string): void {
  push?.(message);
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    push = (message) => {
      const item = { id: ++seq, message };
      setItems((prev) => [...prev, item]);
      setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== item.id));
      }, 2400);
    };
    return () => {
      push = undefined;
    };
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="vn-toast" data-testid="toast-host">
      {items.map((t) => (
        <div key={t.id}>{t.message}</div>
      ))}
    </div>
  );
}
