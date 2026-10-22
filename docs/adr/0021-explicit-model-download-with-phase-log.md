# 模型下载改为显式触发：进度与阶段日志一直显示到「就绪」

首次启动会在用户还没看到设置页时自动下载 1.1 GB 模型，网络不划算或想先「导入本地模型」的用户没有选择机会。下载到 100% 后到真正「就绪」之间还有校验、解压、安装，界面这段时间只显示 100%，用户以为卡死；出问题也只有一个最终错误。

## Status

已接受（accepted）。修订 [ADR-0004](./0004-first-run-model-download-and-macos-first.md) 的「首次启动自动下载」与 [ADR-0015](./0015-model-download-import-and-editable-llm-fields.md) §4 的下载交互；目录位置见 [ADR-0020](./0020-unified-data-root-and-dev-home.md)。

## 证据

- `main/index.ts` 的 `maybeAutoDownload`：本地 provider、未 ready、未尝试过、`VNOTE_DISABLE_MODEL_DOWNLOAD!=1` 就启动下载；验收脚本必须设这个变量来避免真实下载。
- `SettingsPage.tsx` 收到进度事件后用 `snap.state === "downloading"` 决定是否显示进度条；`verifying` / `installing` / `done` 立刻隐藏。
- 下载 740 MB 的 ASR 包后还要 `sha256` 校验、`bunzip2` 解包（约 1.1 GB 落盘）与原子改名，这段时间没有第二类反馈。

## 决定

1. **不自动下载。** 删除 `maybeAutoDownload`、`asr.autoDownloadAttemptedAt`、`ModelsStatus.autoDownloadDisabled` 与 `VNOTE_DISABLE_MODEL_DOWNLOAD`。进程启动后仍后台跑一次 sha256 校验（只读），让上次下载好的模型恢复「就绪」。下载只能由设置页「下载模型」触发，用户可以先「导入本地模型」。
2. **阶段日志来自 core。** `downloadBundle` / `downloadModels` 新增 `onLog?: (line: {level, text}) => void`，按阶段发中文行：开始（包名与大小）、续传起点、每 10% 一条、校验 sha256、解压、安装、完成。不含 URL 凭据与 key。
3. **IPC 带日志。** `models:event` 的负载改为 `{ snapshot, log }`；`log` 是 main 维护的环形缓冲（上限 200 行，每次下载开始时清空），每行带 ISO 时间戳与 level。快照状态沿用 `downloading | verifying | installing | done | failed | cancelled`。
4. **进度条留到就绪。** renderer 记住「本次已开始下载」：`verifying` / `installing` 显示不确定进度，`done` 之后如果 `models().ready` 仍为 false 也保持显示；只有 ready、failed 或 cancelled 才收起。日志面板固定高度、可滚动、自动贴底，空时显示占位。
5. **结束复核。** 下载循环结束后 main 再查一次 `modelStatus`；未 ready 就发 `failed` 快照并带可读原因，而不是报「完成」。

## Considered Options

- **保留自动下载、只加日志**：用户仍然没有先导入本地的机会，而且下载会与首启的其他初始化抢资源。
- **把日志塞进 `DownloadSnapshot.message`**：只能看到最后一行，历史丢失；滚动日志面板需要完整列表。
- **renderer 自己按快照状态拼日志**：校验/解压的具体文件名与耗时只有 core 知道，拼出来的是猜测。

## 后果

- 首次启动不再产生流量；没模型的用户在设置页看到「缺失」，并明确知道要点「下载模型」或「导入本地模型」。
- 下载期间用户能看到「校验中」「解压中」与逐行日志，100% 不再等于静默。
- 验收脚本不再需要 `VNOTE_DISABLE_MODEL_DOWNLOAD`；下载流程的验收需要显式点击并等待 ready。
- `asr.autoDownloadAttemptedAt` 从设置文件解析中移除；旧 v3 文件里残留该键会被忽略。
