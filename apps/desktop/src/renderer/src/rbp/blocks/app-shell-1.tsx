"use client";

import type { ReactNode } from "react";

// app-shell-1 改造：AppFrame = 侧栏导航（视频库/术语表/设置）+ 面包屑顶栏 + 内容槽。
// 原型没有统计块、导入按钮、状态胶囊与头像，全部移除。

type NavKey = "library" | "glossary" | "settings";

const NAV_ITEMS: Array<{ key: NavKey; icon: string; label: string }> = [
  { key: "library", icon: "▦", label: "视频库" },
  { key: "glossary", icon: "⌘", label: "术语表" },
  { key: "settings", icon: "⚙", label: "设置" },
];

type Crumb = { parts: string[]; onBack?: () => void };

export function AppFrame({
  active,
  onNavigate,
  crumb,
  appVersion,
  children,
}: {
  active: NavKey;
  onNavigate: (key: NavKey) => void;
  crumb: Crumb;
  appVersion?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="vn-shell">
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
