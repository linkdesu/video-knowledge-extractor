# 本地 ASR 单段解码上限从 80 秒降到 30 秒（Electron 内存边界）

打包试用版第一次在桌面端跑真实的 10 分钟视频时，转写在第 61/82 条字幕处整个 worker 进程 SIGTRAP 退出。崩溃点是 FireRedASR 对一个 70.2 秒连续说话段做一次前向：ONNX Runtime 的 `BFCArena::Extend` 申请一块巨大的对齐内存，Electron 进程在这个尺寸上直接中止。把单段解码上限收紧到 30 秒后同一视频完整跑通。

## Status

已接受（accepted）。修订 [ADR-0003](./0003-asr-engine-firedasr-ctc.md) 的「单段上限 80 秒」，与 [ADR-0012](./0012-electron-desktop-utility-process.md) 的 worker 边界不冲突（worker 仍是 utility process）。

## 证据

- 视频：`RPReplay_Final1792380024` 前 600 秒（16 kHz 单声道，与 r25 同一素材）。
- 崩溃：`~/Library/Logs/DiagnosticReports/Video Notes Helper-2026-10-22-*.ips`，`EXC_BREAKPOINT / SIGTRAP`，栈顶 `onnxruntime::BFCArena::Extend → operator new(size, align_val_t) → malloc_type_aligned_alloc`，上层是 `OfflineFireRedAsrCtcModel::Forward`。
- 复现点固定：`done=61/82`，即 391.9–462.1s 这一条 70.2 秒字幕行（r25 也记录过它是全片最长行）。
- 同一次解码在纯 Node（v24）与 bun 里都能完成：bun 峰值 RSS 3.86 GB、耗时 8.6 s；Node 峰值 3.34 GB。Electron 里崩溃时进程 RSS 约 2.3 GB，说明不是整机内存不足，而是单次分配尺寸触发 Electron 侧中止。
- 换进程形态无效：把 worker 从 utility process 换成 `ELECTRON_RUN_AS_NODE` 子进程（显式 `execPath` 指回 app 二进制）后仍在同一条字幕上崩溃，栈相同；纯 `node` 二进制则正常。`numThreads: 1` 只让解码从 8.6 s 变慢到 15.9 s，峰值内存不变（3.86 GB）。

## 决定

- `ASR_MAX_UTTERANCE_SECONDS` 从 80 改为 **30**。超长说话段在停顿处切开，切点仍取窗口内离上限最近的静音中点（`splitSpan` 逻辑不变）；切点落在真实停顿上，不会把词切开。
- 同一条 70 秒段的静音中点实测在 411.4、414.5、417.1、422.9、427.9、429.1、432.5、439.5、441.3、445.3、451.8、454.0、456.3、458.5 秒，30 秒上限会把这段切成 3 条，切点都在停顿里。
- worker 仍是 Electron utility process（ADR-0012 不变）。降低上限后单次前向的峰值显著下降，600 秒视频在打包后的 app 里完整跑通。

## Considered Options

- **保留 80 秒，改用纯 Node sidecar**：Node 能跑通同一条字幕，但试用包要么依赖用户装 Node，要么再带一份运行时；进度、取消、prepared 屏障都要重做一遍 IPC。收益只是保住已经偏长的 70 秒字幕行。
- **保留 80 秒，把 worker 改成 `ELECTRON_RUN_AS_NODE` 子进程**：实测在同一条字幕上同样 SIGTRAP，没有解决问题。
- **降低 ONNX 线程数**：峰值内存不变，只变慢。
- **把长段用重叠窗口解码再拼接**：能保留整段行数，但接缝处会重复或丢字，且拼接规则要引入新契约；不如直接按停顿切成多行，阅读粒度也更符合 r25 的结论。

## 后果

- 同一视频的字幕行数会变多（600 秒样例从 82 条量级增加），每行更短；`topic.md` 与切片时间段的派生逻辑不变。
- 分块缓存键包含字幕行列表，升级后第一次重跑会重新解码一次；这是可丢弃缓存，不影响正确性。
- 远程 ASR 不受影响（它有自己的 300 秒块上限）。
- 上限仍然是「内存上限」而不是模型上限：遇到更长的连续语音会多切几刀；如果将来 FireRed 换模型或 Electron 修复分配器，这个常量可以再调。
