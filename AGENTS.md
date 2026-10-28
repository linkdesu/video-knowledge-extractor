# video-notes

- 给 Link 的报告：tmp/report/（中文）；agent 交接：tmp/handoff/。
- bun 优先。omp 不使用 ask 工具。TASK 并发 ≤ 6。

## 每次代码更新的强制流程：递增版本号 + 双机本地重装 (r44)

每次迭代只要修改了应用或核心代码，在完成开发与合并交付时**必须**执行以下两步，确保用户可以直接打开 Mac 或 Windows 上已安装的 `Video Notes` 应用进行最终验收：

1. **同步递增四个包的版本号**：
   - 同时递增 `package.json`、`apps/desktop/package.json`、`apps/cli/package.json`、`packages/core/package.json` 中的 `version`（例如 `0.1.0` -> `0.1.1`）。
   - 应用侧边栏顶部 `[data-testid="app-version"]` 会自动读取并展示 `v{version}`。
2. **在当前 Mac 与 Windows (`gamepc`) 环境重装最新打包版应用**：
   - 执行仓库根目录命令：
     ```bash
     bun run install:local --check-bump-against origin/main
     ```
     （合并进 `main` 后也可直接执行 `bun run install:local`）。
   - 该命令会自动完成并校验：
     - **macOS (`workstation-1`)**：执行 `package:mac` 打包，将最新产物覆盖安装到 `/Applications/Video Notes.app`，清除隔离属性（`xattr -cr`，不改动二进制签名、不触碰系统钥匙串），校验 `Info.plist` 的 `CFBundleShortVersionString` 与当前版本号一致。
     - **Windows (`gamepc`)**：自动获取对应版本的 `Video Notes-<version>-setup.exe`（本地或 GitHub Actions `windows-build.yml` 产物），上传至 `gamepc:D:\code\video-notes\installer\`，先停止正在运行的 `Video Notes.exe` 防止文件锁冲突，再静默安装到标准路径 `D:\code\video-notes\app\Video Notes.exe`，修复桌面与开始菜单快捷方式指向，并校验 `Uninstall Video Notes.exe`、注册表 `DisplayVersion` 及 `resources\app.asar` 版本号完全一致。

## 模型与评审

- agent → 模型映射固定在 `.omp/config.yml`；改映射只改这里，不碰 `~/.omp/agent/config.yml`。
- 评审与判分必须同时包含两个模型，各至少一个：`sol-reviewer`（`openai-codex/gpt-6.1-sol`）与 `k3-reviewer`（`kimi-code/k3`）。interrogate 派这两个评审；arena cross-judge 派两个只读 judge（两模型各一），评分分歧处记为缺口。
- `scout` / `sonic` 跑 `mimo-v2.6-flash`，只做调研与轻量档，禁止担任 reviewer 或 judge。

## UI 设计与 Impeccable 视觉门禁（r45）

- 凡涉及 `apps/desktop/src/renderer/` 的 UI/布局/样式修改，必须派 `@designer` 子代理执行；评审用 `@impeccable-finish-reviewer` 或双模型 reviewer。新功能/界面改版可先跑 `bun run design:prototype --round <N>` 多轮原型工作流。
- 顶层布局铁律：`.vn-shell` 与 `.vn-aside` 的高度必须恒等于 `100vh`（`window.innerHeight`），任何浮层/底部栏/局部组件都不能挤压 `.vn-shell`；任务浮层是右下角 `fixed` 卡片（`job-banner`，日志可折叠 `job-toggle-log`，视口高度 ≤700px 时默认收起），浮层打开时内容区加动态底部留白（`.vn-shell[data-has-job="true"] .vn-content { padding-bottom: var(--vn-job-inset, 360px) }`，值由浮层自身的 `ResizeObserver` 写为 `max(360, 高度 + 32)`）。
- `.impeccable/config.json` 豁免的三条规则（`ai-color-palette` / `gradient-text` / `dark-glow`）是品牌决定，改它等于改品牌；其它 rule 一律不豁免，见 `DESIGN.md` 的「Detector waivers」。
- 每次验证必跑 `bun run verify:detect`（源码 + 运行中 Electron `--cdp` 实时扫描），`primary` 必须为 0；`doctor` 会硬校验视口高度不变量，不满足即失败。
- `impeccable detect` 本机二进制为 `/Users/link/.impeccable/bin/0.1.18/impeccable`（可用 `IMPECCABLE_BIN` 覆盖）。

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage labels at default names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
