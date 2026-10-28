# 顶层视口高度不变量，以及任务浮层

r43 把任务浮层 `job-banner` 从 `position: fixed` 覆盖改成布局内停靠（`#root` 纵向 flex，`.vn-job-dock` 占一块布局槽位）。这直接破坏了顶层布局：`.vn-shell` 不再恒等于 `100vh`，主窗口底部被截断约 320 px；且小窗口下内容仍会溢出（停靠区占掉的高度把 grid 行压小，侧栏最小内容高度又把行撑回）。库页要看到底部卡片必须滚动，终态浮层不关闭就一直占着这段高度。

## Status

已接受（accepted，2026-10-29）。顶层布局恢复并固化为不变量；任务浮层回到右下角 `fixed` 卡片，以内容区底部留白换取「不覆盖可点区域」。取代 [ADR-0031](./0031-undecodable-audio-preflight-and-job-dock.md) §4（仅「浮层改为布局内停靠」这一条；ADR-0031 的音轨预检决定不变）。

## 决定

1. **顶层布局不变量。** `.vn-shell` 与 `.vn-aside` 的高度必须恒等于 `100vh`（`window.innerHeight`）：`.vn-shell` 回到 `width:100%; height:100vh; display:grid; grid-template-columns:236px 1fr; grid-template-rows:minmax(0,1fr); overflow:hidden`，`#root` 不再有 `display:flex`。任何浮层、底部栏或局部组件都不允许挤压 `.vn-shell`。这条不变量由 `verify.ts doctor` 在每次验证时硬校验（`getBoundingClientRect().height` 与 `innerHeight` 差 `<= 2`），不满足即失败、退出码 1。
2. **任务浮层回到右下角 `fixed` 卡片。** `JobProgress` 是 `vn-card fixed bottom-4 right-4 z-40 w-[440px]` 的视口锚定卡片，不占布局槽位（`data-testid="job-dock"` 被彻底移除）。
3. **浮层打开时内容区加底部安全留白。** `AppFrame` 以 `hasActiveJob` 在 `.vn-shell` 上输出 `data-has-job="true|false"`；`.vn-shell[data-has-job="true"] .vn-content { padding-bottom: 360px }`，使库页滚动到底后卡片按钮完整位于浮层上方（`elementFromPoint` 命中按钮本身）。`doctor` 同时硬校验：浮层打开时 `.vn-content` 的 `padding-bottom >= 360`。
4. **浮层日志可折叠。** `job.logs.length > 0` 时渲染 `[data-testid="job-toggle-log"]` 折叠按钮（默认展开，`aria-expanded`）；折叠时 `data-testid="job-log-tail"` 整个节点从 DOM 消失，进度行、状态与操作按钮保留。

## Considered Options

- **保留 r43 的块级停靠**：不覆盖可点区域，但代价是 `.vn-shell` 失去 `100vh`，主窗口底部被截断约 320 px，小窗口下内容仍溢出；停靠区与窗口高度形成隐式耦合，任何侧栏最小高度变化都可能复现溢出。放弃。
- **浮层 `fixed` 但不加留白**：布局不变量成立，但浮层仍会压住滚到底部的卡片按钮（r42 QA 的原问题）。用 360 px 留白换取「滚到底仍可命中」。
- **把留白做成随浮层实际高度计算**：浮层高度随日志条数在约 130–300 px 间变化，逐帧计算会引入滚动抖动；固定常量 360 px 覆盖浮层最大高度，成本是浮层较矮时多留约 60–230 px 空白，可接受。

## 后果

- 留白常量 `360px` 必须保持「≥ 浮层最大高度」的隐式耦合：浮层样式改动若使其最大高度超过 360 px，会重新压住卡片按钮；`doctor` 的 `padding-bottom >= 360` 校验是这条耦合的回归探针。
- `doctor` 的视口高度不变量失败即视为布局回归：`.vn-shell` / `.vn-aside` 不再恒等于 `100vh` 的任何 UI 改动都会在这里暴露。
- 浮层打开时库页底部有 360 px 空白；终态浮层关闭后留白随之消失。
- r43 的 `contentBottom === dockTop` 断言与 `data-testid="job-dock"` 选择器作废；features 文档与 ADR-0031 §4 按本 ADR 更新。
