# 主题页播放器适配容器、库卡片即时刷新与生成按钮计数

r33 的 QA 打回三个问题：主题页播放器在固定高度模式下把竖屏视频撑到 507×1099，被 420 px 的容器（`overflow:hidden`）裁掉画面与原生控件；勾选/合并主题后回到视频库，卡片状态仍停在「已完成」直到重启；生成按钮按全部已勾选数显示，让人以为会重跑已生成的主题。

## Status

已接受（accepted）。取代 [ADR-0025](./0025-generate-notes-after-topic-confirmation.md) 中「主题页按钮文案不变、提交全部 selected id」的界面约定（core 的 `done` 过滤保持不变，作为第二道防线）；数据格式、目录布局与生成语义不变。

## 决定

- **固定高度模式下视频绝对定位铺满容器。** `Player` 定高分支的 `<video>` 用 `position:absolute; inset:0; width:100%; height:100%; object-fit:contain`（`apps/desktop/src/renderer/src/components/Player.tsx`）。容器是 `display:grid; place-items:center`，grid 行高按内容回推，百分比 `max-height/max-width` 会以视频固有尺寸为基准（竖屏 886×1920 → 507×1099），既夹不住视频也把控件区推到容器外。绝对定位让视频盒恒等于容器内容盒，`contain` 负责画面留边，原生控件随之落在容器内。非定高（横屏默认）分支保留自适应，补 `maxWidth: 100%` 与 `maxHeight: 62vh` 同时生效。
- **竖屏默认高度取 `min(420, round(60% 窗口高))`。** 没有 `localStorage['vn.topics.playerHeight']` 时按此计算；用户拖拽过的高度优先，不被默认值覆盖。拖拽夹取区间不变（240 … min(900, 80% 窗口高)），任何高度下都不裁切。
- **视频库在切回与窗口聚焦时刷新。** `App` 在 `route.name === "library"` 的 effect 与 `window` 的 `focus` 监听里调用 `refreshLibrary()`（`apps/desktop/src/renderer/src/App.tsx`）；初始路由就是视频库，首帧刷新由同一条 effect 覆盖。job 结束与封面事件的原刷新路径不变。
- **生成按钮只计本次真正要生成的主题。** `topics-generate` 的数量 = `selected && status !== "done"`（与 core 的过滤同口径），点击时只提交这批 id；所选主题全部已生成时按钮禁用并显示「所选主题笔记已生成」；未勾选任何主题时显示「生成笔记（0 个新主题）」并保持可点，点击只弹「先勾选要生成的主题」的 toast（与 ADR-0025 的既有提示一致）。

## Considered Options

- **保留百分比 `max-height: 100%`，只把容器改成 `flex` 或显式 `grid-template-rows: 100%`**：仍然依赖 grid/flex 的行高解析，真机上 video 的固有尺寸参与行高计算，回归风险高；绝对定位把「视频盒 = 容器盒」写成确定事实。不采用。
- **用 `ResizeObserver` 量容器高度再给 video 设像素高度**：多一份运行时状态与一帧延迟，且拖拽过程中会抖动。CSS 已能表达。不采用。
- **视频库定时轮询 `listLibrary`**：切回与聚焦两个入口已覆盖用户的全部观察时机（页面切换、切换回窗口），轮询只增加无谓的磁盘读取。不采用。
- **按钮继续显示全部勾选数、只在文案里解释「已生成的会跳过」**：QA 已实测用户会误读，数量与本次工作量不一致是根因。不采用。

## 后果

- 主题页播放器在任何高度、任何方向下 `video` 盒都不超出 `player` 盒，原生控件在视口内；验收断言写在 `<skill://verify-video-notes>/features/topics.md`「Player fits its container」。
- 库卡片在勾选未生成主题、合并主题后立即显示「部分完成」；验收断言写在 `<skill://verify-video-notes>/features/library.md`「Immediate status refresh」。
- 生成按钮的数量与 `runNotes` 实际处理的 id 一致；core 仍过滤 `done`，绕过界面直接调 IPC 也不会重跑已生成主题。
