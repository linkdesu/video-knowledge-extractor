"use client";

import type { ReactNode } from "react";

// app-shell-1 改造：AppFrame = 侧栏导航（整理笔记/整理切片/术语表/设置）+ 面包屑顶栏 + 内容槽。
// r82：「视频库」更名「整理笔记」（页面内容不变），新增「整理切片」（项目列表与项目页）。
// nav-library 的 testid 保持不变：验收脚本用它在启动后判定界面就绪。

type NavKey = "library" | "slicer" | "glossary" | "settings" | "lab";

const NAV_ITEMS: Array<{ key: NavKey; icon: string; label: string }> = [
  { key: "library", icon: "▦", label: "整理笔记" },
  { key: "slicer", icon: "✂", label: "整理切片" },
  { key: "glossary", icon: "⌘", label: "术语表" },
  { key: "settings", icon: "⚙", label: "设置" },
];

type Crumb = { parts: string[]; onBack?: () => void };

export function AppFrame({
  active,
  onNavigate,
  crumb,
  appVersion,
  hasActiveJob,
  lab,
  children,
}: {
  active: NavKey;
  onNavigate: (key: NavKey) => void;
  crumb: Crumb;
  appVersion?: string | null;
  hasActiveJob?: boolean;
  /** 开发模式验收台（r48）：只有未打包时由 App 传入 true。 */
  lab?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="vn-shell"
      data-has-job={
        hasActiveJob === undefined ? undefined : hasActiveJob ? "true" : "false"
      }
    >
      <aside className="vn-aside">
        <div className="vn-brand">
          <div className="vn-logo" aria-hidden="true" />
          <div className="vn-brand-meta">
            <b>VideoNotes</b>
            {appVersion ? (
              <span className="vn-brand-ver" data-testid="app-version">
                v{appVersion}
              </span>
            ) : null}
          </div>
        </div>
        <nav className="vn-nav" aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              data-testid={`nav-${item.key}`}
              className={`vn-nav-btn${active === item.key ? " on" : ""}`}
              onClick={() => onNavigate(item.key)}
            >
              <span className="vn-ico" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
          {lab === true ? (
            <button
              type="button"
              data-testid="nav-lab"
              className={`vn-nav-btn vn-nav-lab${active === "lab" ? " on" : ""}`}
              onClick={() => onNavigate("lab")}
            >
              <span className="vn-ico" aria-hidden="true">🧪</span>
              Lab
            </button>
          ) : null}
        </nav>
      </aside>
      <div className="vn-main">
        <div className="vn-topbar">
          <div className="vn-crumb" data-testid="breadcrumb" aria-label="面包屑">
            {crumb.parts.map((label, i) => (
              <span key={i}>
                {i > 0 ? (
                  <span aria-hidden="true" style={{ opacity: 0.5 }}>
                    {" "}
                    /{" "}
                  </span>
                ) : null}
                {i === 0 && crumb.onBack !== undefined ? (
                  <button
                    type="button"
                    className="vn-crumb-back"
                    onClick={crumb.onBack}
                    data-testid="breadcrumb-back"
                  >
                    {label}
                  </button>
                ) : i === crumb.parts.length - 1 ? (
                  <b>{label}</b>
                ) : (
                  <span>{label}</span>
                )}
              </span>
            ))}
          </div>
        </div>
        <div className="vn-content">
          <div className="vn-wrap">{children}</div>
        </div>
      </div>
    </div>
  );
}
