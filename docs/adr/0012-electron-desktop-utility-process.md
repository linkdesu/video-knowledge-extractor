# Electron 桌面端把 core 放进 utility process，core 改为运行时中立

界面要跑与 CLI 完全相同的三步流水线。ADR-0007 要求界面只调 core，但 core 当时依赖两个 Bun 运行时 API，且转写用的原生模块在 Electron 下的行为没有验证过。本轮把 `apps/desktop` 做出来，同时把 core 从 Bun 运行时里解耦，让 CLI 与桌面共用同一份实现。

## Status

已接受（accepted）。落实 [ADR-0007](./0007-core-library-cli-first-and-note-format.md) 的界面顺序，修订其中「原生 addon 要按 Electron ABI 重建」的后果，并关闭 [ADR-0011](./0011-stale-topic-output-cleanup.md) 的「同一视频并发会互删」这一已知限制。

## 决定

- **应用位置与栈**：`apps/desktop`，包名 `@video-notes/desktop`，Electron 45 + electron-vite 6 + React 19。主进程、preload、提取 worker 与 renderer 各自打包；`sherpa-onnx-node` 保持 external，工作区里的 `@video-notes/core` 打进 bundle。
- **core 运行时中立**：`Bun.CryptoHasher` 换成 `node:crypto`，`Bun.spawn` 换成 `node:child_process`。CLI 仍由 bun 运行，测试仍是 `bun test`；桌面主进程与 worker 是 Electron 的 Node 运行时。
- **WAV 自己解析**：Electron 45 禁止 NAPI 的 external buffer，`sherpa.readWave` 在 utility process 里抛 `External buffers are not allowed`。`readWav` 改为 `core/wav.ts` 里的纯 JS 实现：RIFF/WAVE、16-bit PCM、多声道下混。实测同样的 Float32Array 传给说话人分离与识别正常。
- **提取在 utility process 里跑**：每个任务 fork 一个新 worker，不复用。主进程启动时加载 dotenv 并解析端点，把 `{baseUrl, apiKey, model}` 随 `start` 消息传入；worker 只负责跑 `runExtract`，用 `process.parentPort` 发 progress、done、error。
- **取消是进程级的**：worker 收到 `cancel` 后调用 `killActiveChildren()` 杀掉 core 登记的 ffmpeg/ffprobe，然后退出。主进程丢弃此后的进度与结果消息，等 worker 的 exit 事件才落 `cancelled`；1.5 秒内没退出就杀掉残留子进程并强制结束。终态只落一次。
- **串行**：主进程的 `JobQueue` 并发度为 1，排队任务可立即取消。应用退出时先取消运行中的任务，再退出。
- **跨进程锁**：`runExtract` 自己持有 `<视频目录>/.cache/run.lock`，内容是 `{pid, startedAt}`。只有持有者进程不存在（ESRCH）才算陈旧，活进程一律抢占失败。CLI 与桌面因此互斥。
- **切片原子写**：ffmpeg 先写 `<切片>.part-<pid>.mp4`，成功后再 rename。取消或崩溃不会留下被 `size > 0` 判定为完成的半成品。
- **IPC 契约**：`apps/desktop/src/shared/ipc.ts` 是 renderer 与 main 之间唯一的类型来源。`contextIsolation` 与 `sandbox` 开启，`nodeIntegration` 关闭，preload 输出 CommonJS（sandbox 下的 preload 不能是 ESM）。renderer 不 import core 的类型。
- **媒体与页面来源**：切片走 `vnote-media://clip/<base64url>`，主进程校验解码后的路径在 NOTES_ROOT 内且 realpath 后仍在，支持 Range 请求。生产环境的 renderer 由 `vnote-app://` 提供，因为 Chromium 在 `file://` 下不执行 ES module。
- **源视频路径**：notes 根目录的 `index.json` 条目新增可选 `sourcePath`。旧条目没有记录时，界面让用户重新选择源文件，并用 id 校验选中的文件确实是同一个视频。
- **设置只读状态**：显示端点是否已配置、显式配置的模型名（没配就显示自动发现）、NOTES_ROOT、模型目录、已加载的 dotenv 文件、ffmpeg 是否可用。key 不出现在 IPC 返回值、日志或错误消息里。

## Considered Options

- **bun sidecar**：主进程 spawn 一个 bun 子进程跑 core，stdout 走 JSONL。core 零改动，生产环境却要求用户装 bun；进度协议要自己定义并维护；与简报「core 跑在 main 或 utility process」冲突。不采用。
- **core 直接在 Electron main 里跑**：同步 ASR 解码会卡住窗口，取消也没有进程边界。不采用。
- **为 Electron ABI 重建 sherpa-onnx-node**：不需要。该模块导出 `Napi::` 符号，是 Node-API 模块；Electron 45（NODE_MODULE_VERSION 150）直接加载并完成分离与识别。NAPI 不能覆盖的部分只有 `readWave` 的 external buffer，已用纯 JS 解析替换。
- **让 renderer 直接读文件（`webSecurity: false`）**：省一个自定义协议，代价是关掉渲染进程的安全边界。不采用。

## 后果

- 打包（第 5 步）必须把 `sherpa-onnx-node`、平台包与 dylib 一起放进应用并保持 external。本轮只验证 dev 运行与能启动的 production build，不做签名与 DMG。
- 每个任务 fork 一个新 worker，多几十毫秒启动成本，换来没有跨任务状态。
- 取消发生在同步 ASR 解码期间时，worker 要等当前解码段（最多约 80 秒）回到事件循环才能响应；主进程 1.5 秒后强杀进程并清理子进程。锁文件由死进程残留，下次运行按 ESRCH 接管。
- 锁靠 pid 判断存活。pid 被新进程复用时旧锁会被误认为仍在运行，这是已知限制，没有引入进程启动时间比对。
- `index.json` 增加可选字段，旧文件照常读取；写入 `sourcePath` 后，同一视频从界面重跑不再需要重新选择源文件。
- 主进程会尝试模型发现一次（没有显式模型名时）；发现失败时设置页显示已配置，但启动提取会给出明确错误。
