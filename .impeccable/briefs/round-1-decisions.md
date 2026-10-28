# Round 1 — Decision Card (video-notes)

- run: `r45-dev-smoke`
- round: 1
- updated: 2026-10-28T17:35:17.537Z
- PRODUCT.md: updated this round

## Confirmed (本轮确认)

- 任务浮层回到右下角 fixed 卡片
- .vn-shell 与 .vn-aside 恒等于 100vh
- 浮层打开时内容区动态底部留白（>=360px）
- job-toggle-log 折叠日志；<=700px 高窗口默认收起

## Rejected (本轮否决)

- r43 的 .vn-job-dock 块级停靠（截断主窗口底部）
- `#root` 改纵向 flex、`.vn-shell` 用 `flex: 1` 在网格外再挤出停靠行

## Open Questions (待决分歧)

- None

## Key Selectors (data-testid)

- `[data-testid="app-version"]` — 侧边栏版本号（required）
- `[data-testid="nav-library"]` / `nav-glossary` / `nav-settings` — 侧栏导航（required）
- `[data-testid="job-banner"]` — 任务浮层（optional，仅任务时出现）
- `[data-testid="job-toggle-log"]` — 浮层日志折叠开关（optional）
- `[data-testid="player-unsupported-format"]` — MPEG-TS 源不可预览提示（optional）
