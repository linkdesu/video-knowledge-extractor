"use client";
import { useEffect, useState } from "react";
import { animate, useReducedMotion } from "motion/react";

// 受控计数卡片：数值变化时从 0 补间到目标值，系统请求减少动画时直接显示目标值。
const ease = [0.16, 1, 0.3, 1] as const;

export function StatTiles({ items }: { items: { label: string; value: number }[] }) {
  const reduce = !!useReducedMotion();
  const [shown, setShown] = useState<Record<string, number>>({});

  // items 由调用方每渲染新建字面量，用拼接键做依赖，避免补间随渲染重启。
  const key = items.map((i) => `${i.label}:${i.value}`).join("|");

  useEffect(() => {
    if (reduce) return;
    const controls = items.map((item) =>
      animate(0, item.value, {
        duration: 1.6,
        ease,
        onUpdate: (v) =>
          setShown((prev) => (prev[item.label] === v ? prev : { ...prev, [item.label]: v })),
      }),
    );
    return () => controls.forEach((c) => c.stop());
  }, [reduce, key]);

  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((item) => {
        const display = (reduce ? item.value : shown[item.label] ?? 0).toLocaleString("en-US");
        return (
          <div
            key={item.label}
            className="flex min-w-0 flex-col gap-2 rounded-[var(--rb-r-lg,10px)] border border-neutral-900/10 bg-white px-4 py-3 dark:border-neutral-100/14 dark:bg-neutral-900"
          >
            <span className="text-[14px]/[16px] font-[450] text-neutral-900/80 dark:text-neutral-100/80">
              {item.label}
            </span>
            <span className="text-[28px]/[32px] font-[450] tabular-nums text-neutral-900 dark:text-neutral-100">
              {display}
            </span>
          </div>
        );
      })}
    </div>
  );
}
