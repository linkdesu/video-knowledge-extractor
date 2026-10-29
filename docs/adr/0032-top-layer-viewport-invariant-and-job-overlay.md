# 顶层视口高度不变量，以及任务浮层

r43 把任务浮层 `job-banner` 从 `position: fixed` 覆盖改成布局内停靠（`#root` 纵向 flex，`.vn-job-dock` 占一块布局槽位）。这直接破坏了顶层布局：`.vn-shell` 不再恒等于 `100vh`，主窗口底部被截断约 320 px；且小窗口下内容仍会溢出（停靠区占掉的高度把 grid 行压小，侧栏最小内容高度又把行撑回）。库页要看到底部卡片必须滚动，终态浮层不关闭就一直占着这段高度。

## Status

已接受（accepted，2026-10-29）。顶层布局恢复并固化为不变量；任务浮层回到右下角 `fixed` 卡片，以内容区底部留白换取「不覆盖可点区域」。取代 [ADR-0031](./0031-undecodable-audio-preflight-and-job-dock.md) §4（仅「浮层改为布局内停靠」这一条；ADR-0031 的音轨预检决定不变）。

## 决定

1. **顶层布局不变量。** `.vn-shell` 与 `.vn-aside` 的高度必须恒等于 `100vh`（`window.innerHeight`）：`.vn-shell` 回到 `width:100%; height:100vh; display:grid; grid-template-columns:236px 1fr; grid-template-rows:minmax(0,1fr); overflow:hidden`，`#root` 不再有 `display:flex`。任何浮层、底部栏或局部组件都不允许挤压 `.vn-shell`。这条不变量由 `verify.ts doctor` 在每次验证时硬校验（`getBoundingClientRect().height` 与 `innerHeight` 差 `<= 2`），不满足即失败、退出码 1。
2. **任务浮层回到右下角 `fixed` 卡片。** `JobProgress` 是 `vn-card fixed bottom-4 right-4 z-40 w-[440px]` 的视口锚定卡片，不占布局槽位（`data-testid="job-dock"` 被彻底移除）。
3. **浮层打开时内容区加底部安全留白。** `AppFrame` 以 `hasActiveJob` 在 `.vn-shell` 上输出 `data-has-job="true|false"`；`.vn-shell[data-has-job="true"] .vn-content { padding-bottom: var(--vn-job-inset, 360px) }`；`--vn-job-inset` 由浮层自身的 `ResizeObserver` 写成 `max(下限, 浮层高度 + 32px)`，下限在窗口高度 ≤700px 时取 240px、否则 360px。这样库页滚动到底后卡片按钮完整位于浮层上方（`elementFromPoint` 命中按钮本身），矮窗口也不会被固定 360px 吃掉整个内容区。`doctor` 同时硬校验：浮层打开时 `.vn-content` 的 `padding-bottom >= 浮层高度 + 32` 且 `>= 240`。
4. **浮层日志可折叠。** `job.logs.length > 0` 时渲染 `[data-testid="job-toggle-log"]` 折叠按钮（默认展开，`aria-expanded`）；折叠时 `data-testid="job-log-tail"` 整个节点从 DOM 消失，进度行、状态与操作按钮保留。

## Considered Options

- **保留 r43 的块级停靠**：不覆盖可点区域，但代价是 `.vn-shell` 失去 `100vh`，主窗口底部被截断约 320 px，小窗口下内容仍溢出；停靠区与窗口高度形成隐式耦合，任何侧栏最小高度变化都可能复现溢出。放弃。
- **浮层 `fixed` 但不加留白**：布局不变量成立，但浮层仍会压住滚到底部的卡片按钮（r42 QA 的原问题）。用随浮层高度变化的留白（下限 360/240 px）换取「滚到底仍可命中」。
- **把留白做成随浮层实际高度计算**：最初担心浮层高度随日志条数在约 130–300 px 间变化、`ResizeObserver` 更新会引入滚动抖动，于是先用了固定 360 px。复审后改为 `ResizeObserver` 写 `--vn-job-inset`：实测展开/收起切换不产生滚动抖动（高度只在浮层自身变化时更新一次），而且固定常量盖不住「长失败文案把浮层撑到 380 px 以上」的情形。下限保留 360 px，矮窗口（≤700px 高）降到 240 px。

## 后果

- 留白不再依赖「常量 ≥ 浮层最大高度」的隐式耦合：`--vn-job-inset` 跟着浮层实测高度走；`doctor` 的 `padding-bottom >= 浮层高度 + 32 且 >= 240` 校验是这条关系的回归探针。
- `doctor` 的视口高度不变量失败即视为布局回归：`.vn-shell` / `.vn-aside` 不再恒等于 `100vh` 的任何 UI 改动都会在这里暴露。
- 浮层打开时库页底部至少有 240–360 px（取决于窗口高度与浮层实际高度）空白；终态浮层关闭后留白随之消失。
- r43 的 `contentBottom === dockTop` 断言与 `data-testid="job-dock"` 选择器作废；features 文档与 ADR-0031 §4 按本 ADR 更新。
