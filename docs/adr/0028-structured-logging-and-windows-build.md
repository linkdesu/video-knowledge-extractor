# 结构化日志与 Windows x64 安装包

Windows x64 是桌面端第一个新平台，macOS 之外没有可安装的产品形态；同时排查问题全靠用户复述，主进程与 utility process 都没有日志文件。本轮把日志做成跨平台的结构化基础设施，并把 Windows 打包与 CI 跑通，让 Windows 用户能装、能用、出问题时能交回证据。

## Status

已接受（accepted）。[ADR-0021](./0021-explicit-model-download-with-phase-log.md) 的「下载只能由设置页手动触发」规则在本轮起有一个例外：Windows 首次启动自动下载模型。打包布局承接 [ADR-0017](./0017-mac-unsigned-package.md) 的 staging 策略；[ADR-0020](./0020-unified-data-root-and-dev-home.md) 的目录约定不变。

## 证据

- `packages/core/src/core/logger.ts`：按天写 `vnote-YYYY-MM-DD.log`，保留今天加前 6 天（7 天），只清理匹配 `LOG_FILE_RE` 的文件；`readTaskLog` 跨文件按 task id 过滤。
- `apps/desktop/src/main/index.ts`：日志目录由 `logDirFor(settings.notesRoot)` 求值为 `<notesRoot>/.logs`，主进程与 extract worker 共用同一目录（worker 由 main 传 `logDir`）；启动日志（版本、commit、打包标志、notesRoot）先于窗口显示。
- `packages/core/src/core/environment.ts`：`collectEnvironment` 收集平台、CPU、GPU、内存与 tools/models/dirs 的路径检查，`formatEnvironment` 输出「exists / missing、大小、非 ASCII、含空格」行，启动时逐行写进 `env` 模块日志。
- `packages/core/src/core/exec.ts`：外部进程（ffmpeg、ffprobe）启动前记整条 argv，结束记退出码与耗时；非零退出再记 stderr 最后 50 行。
- `packages/core/src/llm/openai.ts` 与 `endpoint.ts`：LLM 日志只含 `baseUrl`、`model`、HTTP 状态码、耗时与 token 用量，prompt 与请求体不进日志；key 由 logger 登记后对所有字段自动脱敏。
- `apps/desktop/electron-builder.yml` 与 `scripts/package-win.ts`：NSIS x64 未签名安装包，staging 与 mac 包同一策略。
- `apps/desktop/scripts/fetch-ffmpeg.ts`：固定 URL 与 sha256 拉取 gyan.dev 的 ffmpeg 9.0.2 essentials 静态包。
- `.github/workflows/windows-build.yml`：`windows-latest` runner，typecheck、单测、构建、NSIS 打包、上传产物，无 e2e。

## 决定

1. **日志文件放 `<notesRoot>/.logs`，按天一个文件，保留 7 天（r35 起）。** 目录跟随设置里的 notes 根目录，切换后日志写入、设置页展示、「打开日志文件夹」与「复制诊断信息」同步改用新目录。主进程与 extract worker 写同一个目录；清理只动 `vnote-YYYY-MM-DD.log` 形态的文件，7 天前的自动删除。
2. **每条记录一行：ISO 8601 UTC 毫秒时间戳、级别、模块名、`task=<id>`、消息与 `key=value` 字段。** 模块是固定枚举（import、ffmpeg、asr、diarization、llm、fs、app、env）；未 configure 前所有日志丢弃，dev 模式额外输出到 console。
3. **task id 就是 runToken。** runToken 在任务入队时生成（UUID），main 侧与 worker 侧的日志都挂在同一个 token 上，按 token 能取回一次完整运行的日志。
4. **外部进程记 argv、退出码与 stderr 最后 50 行。** 启动前记整条 argv（argv 里的 URL 也走脱敏）；失败时记退出码、耗时与 stderr 尾部 50 行；抛给用户的错误消息仍只带末尾 12 行，完整信息留在日志里。
5. **LLM 只记 baseUrl、model、HTTP 状态码与耗时。** prompt 与请求体永不进日志；失败响应只记脱敏并截断后的末尾 300 字符。key 登记为 secret 后，所有日志字符串（含 argv 里的 URL）按 secret 与 `bearer` / `api_key=` / `token=` / `authorization:` 通用规则脱敏，脱敏优先于截断。
6. **启动写一条环境日志。** 窗口显示前先写版本、commit、打包标志、userData，再写 `collectEnvironment` 的完整快照：平台、CPU、GPU、内存，以及 tools / models / dirs 每个路径的 exists、大小、非 ASCII、含空格。
7. **设置页两个按钮：「打开日志文件夹」与「复制诊断信息」。** 出问题时用户点「复制诊断信息」，把复制的内容连同日志文件夹里的文件一起发回。
8. **Windows 打包：electron-builder NSIS x64，staging 与 mac 包同一策略。** `bun run package:win` 先把 `out/`、最小 `package.json`、解引用后的 `sherpa-onnx-node` 与 `sherpa-onnx-win-x64` 复制到 `release-win/stage`，再跑 electron-builder；`sherpa-onnx-*/**` 解包出 asar（`.node` 与 dll 不能被 asar 虚拟文件系统加载）。`sherpa-onnx-win-x64` 是 optional 平台包，只在 win32/x64 上安装，macOS 上本机打包会明确报错，请在 Windows CI 上构建。产物 `Video Notes-<version>-setup.exe`（NSIS，允许改安装目录，卸载不删应用数据），未签名。
9. **ffmpeg 随包分发，版本与 sha256 固定。** `bun run fetch:ffmpeg` 从 gyan.dev 拉 ffmpeg 9.0.2 essentials 静态包（`ffmpeg.exe`、`ffprobe.exe`），zip 先过固定 sha256 再解包进 `win-resources/ffmpeg/`，作为 extraResources 进安装包；校验失败直接报错，绝不使用未校验文件。
10. **Windows 首次启动自动下载模型（约 1.1 GB，四个包）。** 进度显示在设置页；这是 [ADR-0021](./0021-explicit-model-download-with-phase-log.md)「不自动下载」规则的显式例外，只适用于 Windows 首次启动。
11. **CI 在 `windows-latest` 构建。** 顺序：安装依赖、typecheck、固定版 ffmpeg 下载、单测、`electron-vite build`、NSIS 打包、上传 `.exe` 产物；e2e 暂不跑。

## Considered Options

- **Windows 上要求用户自装 ffmpeg**：与 mac 包一致，但 Windows 普通用户装 ffmpeg 的门槛高，容易装成 PATH 找不到的版本。安装包体积增加有限，内置更划算。不采用。
- **用 7z 压缩包代替 NSIS 安装包**：少一个打包器，但用户要自己装解压工具或手动解压。NSIS 一步装完、带桌面快捷方式、能改安装目录，体验更好。不采用。
- **Windows CI 里跑 e2e**：需要长时 GUI runner，稳定性维护成本不低。当前 typecheck、单测与打包已拦截构建期问题；e2e 留到安装包对外分发前补。
- **日志写单文件加轮转**：按天文件天然带日期，跨天检索靠 `readTaskLog` 的文件遍历；清理只需删旧文件，不用截断写。不采用。
- **LLM 日志带 prompt 摘要**：内容含视频文本与用户私有信息，且 key 可能出现在 URL 或正文里，脱敏成本高、收益低。只记端点、模型、状态码与耗时。

## 后果

- 安装包未签名：Windows 可能弹 SmartScreen 拦截，用户要点「更多信息 → 仍要运行」（见 `docs/windows-install.md`）。正式对外分发前补签名链路。
- **GPL ffmpeg 二进制随包分发**：分发的是 gyan.dev 的 GPL 构建（`ffmpeg.exe`、`ffprobe.exe`）。按 GPL 要求随包提供许可证与源码获取途径（源码指针指向上游构建页），mac 包仍走系统 ffmpeg 不受影响。
- **Windows 首次启动需要联网**：模型约 1.1 GB 自动下载，进度在设置页可见；断网或下载失败时，模型状态停在「缺失」，用户可稍后重下或走「导入本地模型」。
- **日志含文件路径，属于用户数据**：argv 与环境快照都会带视频与目录路径。日志只写在用户本机的 `<notesRoot>/.logs`，不上传、不外发；保留 7 天。提醒用户发回日志前检查路径里有没有敏感信息；key 已被脱敏，但路径不会。
- **Windows CI 没有 e2e**：安装包在真实 Windows 上的行为目前靠构建、单测与本机验证；对外分发前补 Windows e2e 是明确缺口。
