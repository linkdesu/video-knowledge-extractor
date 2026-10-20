# 语音识别引擎选 FireRedASR v2 CTC

转写要纯 Node/bun 运行、不带 Python，又不能把长句切碎。实测后选定 sherpa-onnx 官方 int8 导出的 FireRedASR v2 CTC 做识别、sherpa-onnx-node 做说话人分离：它在 70s 级长段整段解码的质量接近现有 Python FunASR R2，且没有 Fun-ASR-Nano 的 KV 截断问题。

## Status

已接受（accepted）。与 [ADR-0001](./0001-chunked-transcription-of-long-videos.md) 的关系是部分取代：ADR-0001 的 10–15 分钟分块规则继续有效；本 ADR 只取代块内超长句的切分方式与按块各自编号说话人。

## 决定

- **识别**：`sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25`（`model.int8.onnx` 740MiB，sha256 `ca3dbabd…bb99`），经 `sherpa-onnx-node@1.13.8` 原生 addon 的 `fireRedAsrCtc` 配置，`greedy_search`。上游只导出 FireRedASR2-AED 的 CTC 分支。
- **分离**：`sherpa-onnx-node` 的 `OfflineSpeakerDiarization`（pyannote segmentation 3.0 + CAM++ zh + fast clustering），全程 Node/bun，不引入 Python/torch。
- **长句不切分**：分块规则不变（ADR-0001：按停顿切 10–15 分钟），块内按说话人段整段解码。明确拒绝“把长句切到 ≤30s”的方案；600s 样本里 70.2s 的段整段解出 311 字，与 R2 相似度 95.5%，首尾完整、无重复。
- **单段上限约 80s**：这是内存上限，不是模型上限（180s 仍有完整输出，但峰值 RSS 11.4GB；70.2s 为 4.0GB，108.7s 为 7.3GB）。只有超过约 80s 的单段才在语音停顿处切。
- **说话人编号全局一致**（Q9）：分离可以按音频分块逐块处理，但声纹嵌入在全部块处理结束后一次全局聚类；同一人在整条视频中是同一个说话人，不按块各自编号。
- **专有英文词靠纠错词表**：FireRed 的英文词表只有 584 个 BPE 片段，`skill`、`SQL` 不在其中，CTC 又没有热词接口；已知术语由 `CorrectionList` 修正。未知英文词无法恢复，这是已知代价。

## Considered Options

- **Python FunASR R2**（对照基线）：600s 为 125.2s / 峰值 6.99GB，`skill` 命中 7 次、`SQL` 1 次，质量最好。但需要 Python + torch（venv 1.1GB），Windows 打包风险大，与“纯 Node/bun”冲突，因此不采用。
- **sherpa Fun-ASR-Nano**：512 导出约 25s、1024 导出约 40s 后必然截断，失败形态是整段重复或空输出，且后期不再打日志；不切段时 600s 只剩 2384 字，四个长段全空或只剩 60 字。切到 18–20s 才可用，与“长句不切分”直接冲突，因此不采用。
- **FireRedASR v2 CTC**（选中）：600s 为 94.0s / 峰值 4.5GB，去标点后与 R2 整篇相似度 89.4%、逐段平均 81.0%；77 段全部有输出，无空段、无重复循环。

## 后果

- 转写质量略低于 R2（整篇约低 2.5 个百分点），术语命中 0/8；纠错词表从辅助手段变成必需品。
- 峰值内存由最长单段决定，与视频总长无关；80s 上限把单段峰值压在 4–5GB 量级。
- 进度与缓存仍以 10–15 分钟分块为粒度（ADR-0001），块内的说话人段只是解码单位；说话人编号跨块全局一致。
- 证据：`tmp/report/r12-FireRedASR-CTC样本.md`、`tmp/report/r11-sherpa-FunASR-Nano冒烟与Windows兼容.md`（仅本地，不进 git）。
