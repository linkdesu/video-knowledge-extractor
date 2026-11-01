# 弹层统一 portal 与浮层遮挡契约（r69）

## Status

已接受（accepted，2026-11-02）。适用于所有渲染进程弹层（下拉 listbox、菜单、浮层）与任务浮层的层级/留白/标签更新规则。

## 背景

三个同类缺陷在不同轮次以不同形式复发：

1. **卡片里的弹层被卡片自身困住**（r52b G1 → r52c 修 Select）：`.vn-card` 带 `backdrop-filter`，会自建层叠上下文；`position: absolute` 的 listbox 留在卡片里时，超出卡片高度的选项会被 DOM 后面、层级更高的卡片整块盖住。r52c 只修了 Lab 的 `Select`，设置页 LLM 模型名的 `Combobox` 仍是旧实现（r69 backlog 第 43 行），同一个 bug 换了个组件。
2. **任务浮层遮挡主题页卡片**（r46 GAP-8）：右下角 `job-banner` 是 `fixed` 440px 卡片，主题页右列在多主题时被它盖住；ADR-0032 用 `--vn-job-inset` 底部留白换取「滚到底仍可命中」，但缺少一条对「3+ 主题」的回归判据。
3. **浮层步骤标签滞后**（r46 GAP-7）：标签之前只在某步骤**第一次进度回调**时更新。ASR 要先加载模型（实测 1.2 s，6 分钟样本上分离 ~110 s），期间标签一直停在上一步；实测滞后 2.3 s。

## 决定

1. **弹层一律 portal 到 `document.body`，用 `position: fixed` + 内联锚点几何。**
   - 几何只有一份实现：`apps/desktop/src/renderer/src/lib/popover.ts`（`computePopoverPlacement` / `clipVerticalBand` / `anchorOf` / `listHeightFor` / `popoverStyle`）。`Select` 与 `Combobox` 共用，禁止再在组件里复制「祖先 `overflowY` 求交 / 翻转 / maxHeight」。
   - 纵向可见范围 = 视口 ∩ 所有 `overflow-y !== visible` 的祖先矩形；下方放不下且上方更宽裕时向上翻转；两侧都放不下时压缩 `maxHeight`，下限 72px。
   - 层级固定为 `.vn-select-list.portal { z-index: 55 }`：高于 `.vn-mask`（50）、`job-banner`（40）与 `.vn-shell`（1），低于 `.vn-toast`（60）。新增弹层复用这一层，不允许再引入新的 z-index 档位。
   - 打开期间跟随内容区滚动与窗口缩放（capture `scroll` + `resize`，rAF 合并）；点击外部判定必须同时认触发器容器与 portal 列表。
2. **弹层验收按命中判，不按截图判。** 对每个可见选项取中心 `document.elementFromPoint()`，断言 `closest('[role=option]')` 就是该选项；再用真实鼠标点击断言触发器/输入值变成该选项。至少覆盖 1280 宽与 900×588（矮窗口）两档。截图只作辅助证据。
3. **任务浮层保持 ADR-0032 的层级与留白契约，并加一条「3+ 主题」回归判据。** 浮层打开时 `.vn-content` 底部留白 `--vn-job-inset = max(下限, 浮层高度 + 32)`（下限 360px，视口高 ≤700px 时 240px）；判据是滚到内容底部后：最后一张主题卡的「查看字幕」按钮矩形位于浮层顶边之上，且按钮中心的 `elementFromPoint` 命中按钮自身，最后一张卡与浮层矩形不相交。r69 在 8 主题样本上实测 1280×868（浮层 288px 高 / inset 360px）与 1280×568（浮层 138px / inset 240px）两档均满足。
4. **步骤标签由「步骤开始事件」驱动，不由第一次进度回调驱动。** core 在每个步骤开始前发一条 `Progress`（`done: 0`）：`normalize`（`0/100`）、`transcribe`（`0/0`）、`segment-topics`（`0/chunks.length`）、`generate-notes`（每主题开始前 `topicPercent: 0`）。renderer 的浮层标签只按最新 `JobSnapshot.step` 派生，不加节流、不加本地缓存。单测锁住「步骤起始事件先于该步骤的第一次进度」。

## Considered Options

- **给 `.vn-card` 加 `overflow: visible`**：会破坏卡片的裁剪与毛玻璃边界，且 `backdrop-filter` 仍会产生层叠上下文，翻不翻转都不稳定。放弃。
- **每个组件各写一份几何**：r52c 与 r69 的两次重复已经证明会漂移（一个修了、一个没修），且翻转/压缩边界难以逐份测。收敛到 `lib/popover.ts`。
- **用 CSS `position: fixed` 但不 portal**：`backdrop-filter` 祖先仍是包含块，`fixed` 会被困在卡片坐标系里（r37 合并说话人弹窗的旧 bug）。必须 portal。
- **给进度事件加节流/去抖**：会让标签更滞后，方向相反。步骤开始事件是零成本的一次 IPC。

## 后果

- 任何新的下拉/菜单/浮层：portal + `lib/popover.ts` + `z-index 55` 是默认做法；留在卡片里的弹层视为回归。
- 任何新的管线步骤：必须在步骤开始处发 `Progress`（`done: 0`），否则浮层标签会滞后；`extract.test.ts` 的顺序断言是模板。
- `.vn-select-list.portal` 的 `z-index` 成为唯一弹层层级；新增层级必须先改本 ADR。
- 任务浮层的遮挡结论有可复跑的几何判据（`tmp/verify/r69-ui-overlay/topics-occlusion*.json`），不再依赖「本轮只有 2 个主题没复现」这种观察。
