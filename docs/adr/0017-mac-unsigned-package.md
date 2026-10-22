# macOS 未签名试用包：打包布局、外部 ffmpeg 与云端 ASR 门禁

Link 要一个能在本机安装试用的 Mac 版本，但签名、公证与云端 ASR 都还没到发布条件。本轮把第 5 步（打包）做成可重复的命令，并让试用包只走本地 sherpa-onnx，云端提供方（OpenAI 兼容 / 火山）留在代码里、默认不暴露。

## Status

已接受（accepted）。落实 [ADR-0004](./0004-first-run-model-download-and-macos-first.md) 的发布顺序与 [ADR-0012](./0012-electron-desktop-utility-process.md) 的打包后果；[ADR-0016](./0016-volcengine-flash-asr-provider.md) 的云端 ASR 实现保留，仅由运行开关门禁。

## 决定

- **打包命令**：`apps/desktop` 的 `bun run package:mac` = `electron-vite build` + `bun scripts/package-mac.ts`。产物在 `apps/desktop/release/`（不进 git）：`Video Notes-darwin-arm64/Video Notes.app` 与 `Video Notes-<version>-arm64.dmg`。只做 darwin arm64，未签名、未公证。
- **打包器与 staging**：用 `@electron/packager`（Electron 官方）而不是 electron-builder，DMG 用系统自带 `hdiutil`。脚本先把「运行时真正需要的文件」复制到 `release/stage`：`out/`、最小 `package.json`（`main: out/main/index.js`、`type: module`、`productName: Video Notes`），以及解引用后的 `sherpa-onnx-node` 与 `sherpa-onnx-darwin-arm64`。理由：仓库是 bun workspace，`node_modules` 是符号链接布局，`@video-notes/core` 已打进 bundle；依赖推断式打包器会去扫 6 个平台包与 workspace 链接，产物不可预测。
- **asar 与解包**：`app.asar` 包含 `out/` 与两个原生包，`**/node_modules/sherpa-onnx-*/**` 解包到 `app.asar.unpacked`（`.node` 与三个 dylib 不能被 asar 虚拟文件系统加载）。worker 从 asar 内 fork，`require("sherpa-onnx-node")` 在解包目录里解析到原生包。
- **模型不内置**：沿用 ADR-0004/0015，模型目录仍是 `~/.cache/video-notes/models`（或 `VNOTE_MODEL_DIR`），首次启动自动下载并校验 sha256，也可在设置页导入/校验。安装包因此约 136 MB，不随包带 1.1 GB 模型。
- **ffmpeg 不内置**：`ffmpeg`/`ffprobe` 仍是外部依赖（GPL 构建与 dylib 依赖不随包分发）。Finder 启动的 GUI 进程只有 launchd 最小 PATH，主进程启动时把 `VNOTE_FFMPEG_DIR`、`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin` 补到 `PATH` 最前，core 的 `spawn` 与设置页的 `ffmpeg -version` 探测因此都能找到 Homebrew 安装；仍找不到时设置页显示「未安装」。
- **云端 ASR 门禁**：`VNOTE_ENABLE_CLOUD_ASR=1` 才允许 `openai` / `volcengine` 提供方。默认关闭时：设置页不渲染提供方下拉与云端面板，只显示「本地 sherpa-onnx」；`settings:update` / `asr:update` 拒绝写入非 local 提供方；运行时一律按 local 解析，即使 `settings.json` 里残留 `volcengine` 也不会被调用。r24 的适配器与测试原样保留。
- **应用身份**：`appBundleId = me.xieal.video-notes`，`productName = Video Notes`；userData 因此是 `~/Library/Application Support/Video Notes`（dev 模式下是包名目录）。`VNOTE_USER_DATA` 仍可覆盖，供验收与截图隔离。窗口标题与界面品牌写 `VideoNotes`（无空格），与 bundle/product 名的空格形式并存：Finder、菜单栏与 userData 目录用 `Video Notes`，窗口标题跟随界面品牌。
- **启动时后台校验模型**：校验结果只缓存在进程内，重启后已下载的模型会回到「未校验」，而提取要求 ready。主进程在启动后对「文件齐全但未校验」的包后台校验一遍，省掉每次启动手点「校验模型」；缺文件或已判 invalid 的包不在这里处理（交给自动下载或设置页导入）。校验要占模型目录锁，另一个实例或 CLI 正在校验/导入时取锁会失败：此时只记日志、保持「未校验」，不中断启动（窗口必须照常创建）。

## Considered Options

- **electron-builder + dmg 目标**：DMG 背景、公证钩子更完整，但对 bun 的符号链接与 workspace 依赖推断不稳，且本轮不需要签名链路。不采用；将来做签名/公证时可以只替换打包器，staging 布局不变。
- **把 ffmpeg 静态构建放进 `Contents/Resources`**：用户零依赖，但要把 GPL 构建与许可证一起分发，体积增加约 80 MB，且升级 ffmpeg 变成重新打包。本机试用不需要。不采用。
- **`asar: false`**：worker fork、ESM main、`net.fetch(file://)` 都能少一层风险，代价是 285 MB 里有大量可被随手改动的散文件，且失去 asar 完整性校验。采用 asar + 定向解包。
- **在 core 层删掉云端 provider**：链接收（r24）明确「不要删除 r24 代码；清理标准版 API 是后续单独一轮」。门禁放在桌面主进程，CLI 仍可用 `VNOTE_ASR_PROVIDER` 做开发验证。
- **把云端开关做成设置项**：试用版的目标是「本地唯一路径」，界面上留一个开关只会让人以为云端可用。用环境变量，不进设置页。

## 后果

- 试用包未签名：首次从 DMG 拖出的 app 可能被 Gatekeeper 拦（用户右键打开或 `xattr -dr com.apple.quarantine`），对外分发前必须补签名与公证。
- 不内置 ffmpeg：目标机器需要 `brew install ffmpeg`；设置页会显示探测结果，缺失时提取在抽音频阶段明确报错。
- `VNOTE_ENABLE_CLOUD_ASR` 只影响桌面端；CLI 的远程 ASR 行为不变。
- 打包不重新编译原生模块（Node-API，Electron 45 直接加载）；换 Electron 主版本或换架构（x64）需要重新验证 `sherpa-onnx-node` 的加载路径。
- DMG 与 `.app` 都是本机产物，`release/` 不进 git；版本号取自 `apps/desktop/package.json`。
