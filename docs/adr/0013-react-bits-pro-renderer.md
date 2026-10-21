# 桌面端界面建立在 React Bits Pro 的源码组件上

界面最初是手写 CSS 加两个仿制效果。Link 的组件标准是 React Bits Pro（RBP），仓库 `.env` 里也已经有它的 license。本轮把 renderer 换到 RBP 的源码组件上，同时决定这些源码怎么进仓库、怎么升级。

## Status

已接受（accepted）。落实 [ADR-0012](./0012-electron-desktop-utility-process.md) 里「界面只调 core」的约束，界面层不动 IPC。

## 决定

- **技术栈**：renderer 加 Tailwind CSS 4（`@tailwindcss/vite`）与 `@` 别名；`styles.css` 首行 `@import "tailwindcss"`，`dark` 变体走 class 策略，`index.html` 的 `<html>` 常驻 `class="dark"`。应用只有暗色，RBP 源码里的 light 分支保留但不启用。`--rb-*` 变量取自 RBP 的 `app-ui-theme` 条目，取其中 dark 的一组。
- **获取方式**：走 shadcn registry 协议，但不用 shadcn CLI。`apps/desktop/scripts/vendor-reactbits.ts` 读 `apps/desktop/reactbits.json` 的条目清单，用 `Authorization: Bearer <license>` 拉 `https://pro.reactbits.dev/api/r/{starter|pro}/{name}.json`，把 `components/**` 原样写到 `apps/desktop/src/renderer/src/rbp/**`。
- **license 处理**：只从环境变量或仓库根 `.env` 读，不打印、不落盘到被跟踪文件。仓库里没有 `components.json`、没有 registry 配置、lockfile 也不含 key。新增条目要网络加有效 license；离线环境无法重建 `rbp/`。
- **只用于新增**：`rbp/` 下的文件已经按本项目改过（删演示内容、接真实数据、改文案）。重跑 vendor 会用上游原文覆盖这些改动，脚本头部写明了这一点。
- **strict 补丁**：上游源码按宽松索引检查写，项目开 `noUncheckedIndexedAccess`。vendor 后由脚本按锚点表打最小兜底补丁；锚点找不到就直接失败，避免上游改动被静默吞掉。
- **落位**：库页用 `app-shell-1`，视频详情用 `app-shell-6`，提取进度用 `monitoring-9` 改成的右下角浮层，纠错词表用 `data-table-3`，设置用 `settings-form-1`；空态标题用 `luminous-type`（灯光扫过文字），库统计计数用 `bento-29` 的补间。旧手写 `Spotlight`、`CountUp` 与约 700 行配套 CSS 删除。
- **源码可改**：RBP 卖的是源码，删演示数据、改布局、接真实状态属于正常用法，不是 fork 上游。

## Considered Options

- **用 `npx shadcn add` 安装**：需要 shadcn 项目结构与 `components.json`，每次安装都要网络与 license，装了什么只留在 shell 历史里。脚本加清单把「哪些条目、哪个版本」变成仓库里可复查的一行记录。不采用。
- **只用 `-css` 变体，不引 Tailwind**：创意组件有两种变体，但区块（App UI 与 marketing）只有 Tailwind 一种。不引 Tailwind 就只剩零散动效组件，做不到「主要页面都用 RBP」。不采用。
- **旧 CSS 与 Tailwind 并存**：两套视觉体系叠在一起，没人能判断哪条规则生效，而且旧类失去消费方后只会腐烂。不采用。
- **把 key 写进 `components.json` 让 CLI 直接可用**：key 会进被跟踪文件。绝不采用。
- **把 RBP 源码当 npm 包依赖**：RBP 不发布运行时包，且本项目需要改源码适配真实数据。不采用。

## 后果

- 样式升级靠改 `rbp/` 下的源码；新增条目跑 `bun run rbp:vendor`，但要重做已经改过的部分。条目清单是唯一的「装了什么」记录。
- renderer 产物体积上升（Tailwind 产物约 66 KB CSS，JS 内含 motion、hugeicons 与 lucide 图标集），桌面应用可接受，不做按需拆分。
- 没有 light 主题，也没有主题切换；将来要加得同时改 `--rb-*` 与 `dark` 策略。
- 首次 vendor 依赖外网与有效 license，CI 与离线机器不能重建 `rbp/` 目录，只能使用仓库里的版本。
- 设置页的模型名依赖启动时的一次 `GET /models`；发现失败时显示脱敏错误，提取不受影响。
