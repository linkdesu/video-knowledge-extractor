# 先做核心库与 vnote CLI，再套只调核心库的 Electron 界面

界面要允许改主题、改词表、看切片，但这些操作的结果必须与 CLI 完全一致。先把核心库与 CLI 做出来，能把三步跑通、产物落盘并验收；界面后做，只负责展示与调用，避免在界面里长出第二套逻辑。

## Status

已接受（accepted）。平台范围仍按 [ADR-0004](./0004-first-run-model-download-and-macos-first.md)，首发 macOS Apple Silicon。

## 决定

- **顺序**（Q18）：先核心库 + CLI；Electron 界面后做，只调用核心库，不自带业务逻辑。
- **命令**（Q18）：根命令 `vnote`，主命令 `vnote extract <视频>`，一次跑完转写、主题分析、生成笔记，产物落在该视频的输出目录。
- **验收**（Q18）：用 r6 测试视频完整跑一遍三步，产出符合格式的产物。
- **笔记格式**（Q19）：每个主题一份 `topic.md`：标题、摘要、要点，然后按时间顺序的对话正文，同一人连续发言合并为一段；每个时间段标注时间并链接该时间段的切片。每个视频输出目录里另有一份 `index.md` 作为主题目录。不合并成一篇长文。
- **文件层级**：视频输出目录内的 `index.md` 与 notes 根目录的 `index.json`（[ADR-0002](./0002-filesystem-and-json-storage.md) 的 id ↔ 目录映射）是两份不同文件，不能互相替代。
- **包布局**：核心库在 `packages/core`（包名 `@video-notes/core`，一个公开入口，重新导出 CLI 需要的流水线、配置、env 与 LLM 端点函数），命令行在 `apps/cli`（包名 `vnote`，只做参数解析与终端输出）。未来的 Electron 应用消费同一个核心库，不建第二套业务层。

## Considered Options

- **先做 Electron**：界面早期就能演示，但业务逻辑会先落在渲染进程，CLI 与界面迟早分叉，因此不采用。
- **单篇长文档**：只需一个文件，但改一个主题要重写全篇，也无法按主题链接到切片，因此不采用。

## 后果

- 界面能力受核心库限制：界面想加的功能必须先落到核心库，并能在 CLI 上验证。
- 核心库要同时被 bun 运行的 CLI 和 Electron 主进程使用；`sherpa-onnx-node` 是原生 addon，Electron 侧要按 Electron ABI 重建，否则只能由 CLI 子进程承担转写与切片。
- 一文一题在主题多时文件多，靠 `index.md` 导航；时间段与切片不是一一对应（见 GLOSSARY 的“切片”），链接必须指向真实切片文件。
- r6 视频的验收覆盖流程与产物形态，不覆盖长视频性能；后者由分块规则（[ADR-0001](./0001-chunked-transcription-of-long-videos.md)）承担。
