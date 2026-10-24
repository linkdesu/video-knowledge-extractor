"use client";

import type { CSSProperties, ReactNode } from "react";

// 视频内三页（字幕/主题/笔记）共用壳：步骤条 + 页头 + 左详情右列表。
// 面包屑在 App 层顶栏，外层 vn-wrap 由 AppFrame 提供。

export type WorkspacePage = "transcript" | "topics" | "notes";

const STEPS: Array<{ page: WorkspacePage; label: string }> = [
  { page: "transcript", label: "字幕" },
  { page: "topics", label: "主题" },
  { page: "notes", label: "笔记" },
];

const stepBase: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "8px 14px",
  borderRadius: 12,
  border: "1px solid var(--vn-line)",
  background: "rgba(255,255,255,0.02)",
  color: "var(--vn-muted)",
  cursor: "pointer",
  fontSize: 13,
  transition: "0.18s",
  whiteSpace: "nowrap",
};

const badgeBase: CSSProperties = {
  width: 21,
  height: 21,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  fontSize: 11,
};

export function StepBar({
  page,
  onPage,
  notesReady,
}: {
  page: WorkspacePage;
  onPage: (page: WorkspacePage) => void;
  /** 笔记步骤门控：至少一个主题 done 才可进入。 */
  notesReady: boolean;
}) {
  const cur = STEPS.findIndex((s) => s.page === page);
  return (
    <nav
      aria-label="步骤"
      style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 22px", flexWrap: "wrap" }}
    >
      {STEPS.map((s, i) => {
        const state = i === cur ? "cur" : i < cur ? "done" : "todo";
        const notesBlocked = s.page === "notes" && !notesReady;
        const style: CSSProperties =
          state === "cur"
            ? {
                ...stepBase,
                color: "#fff",
                borderColor: "rgba(34,211,238,0.45)",
                boxShadow: "0 0 24px rgba(34,211,238,0.12)",
              }
            : state === "done"
              ? { ...stepBase, color: "#c4b5fd", borderColor: "rgba(139,92,246,0.35)" }
              : stepBase;
        const badge: CSSProperties =
          state === "cur"
            ? { ...badgeBase, background: "linear-gradient(135deg,#22d3ee,#8b5cf6)", color: "#08080c" }
            : state === "done"
              ? { ...badgeBase, background: "rgba(139,92,246,0.35)", color: "#fff" }
              : { ...badgeBase, background: "rgba(255,255,255,0.08)" };
        return (
          <span key={s.page} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {i > 0 && <span style={{ width: 22, height: 1, background: "var(--vn-line2)" }} />}
            <button
              type="button"
              style={style}
              aria-current={state === "cur" ? "page" : undefined}
              disabled={notesBlocked}
              title={notesBlocked ? "请先在「主题」步骤生成笔记" : undefined}
              aria-label={notesBlocked ? `${s.label}（请先在「主题」步骤生成笔记）` : undefined}
              onClick={notesBlocked ? undefined : () => onPage(s.page)}
            >
              <span style={badge}>{i + 1}</span>
              {s.label}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

// 页头 + 左详情右列表布局原语；外层 vn-wrap 由 AppFrame 提供。
export function Workspace({
  title,
  subtitle,
  actions,
  detail,
  aside,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  detail: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <>
      <div className="vn-row vn-between" style={{ marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <h1 className="vn-h1">{title}</h1>
          {subtitle !== undefined && subtitle !== null ? (
            <p className="vn-sub" style={{ margin: "0 0 22px" }}>
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions !== undefined && actions !== null ? <div className="vn-row">{actions}</div> : null}
      </div>
      <div className="grid items-start gap-[18px] md:grid-cols-[1.05fr_0.95fr]">
        <div style={{ minWidth: 0 }}>{detail}</div>
        <div style={{ minWidth: 0 }}>{aside}</div>
      </div>
    </>
  );
}
