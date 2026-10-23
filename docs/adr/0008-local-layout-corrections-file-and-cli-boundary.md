# 目录布局、纠错词表文件格式与命令行边界

ADR-0002 与 ADR-0005 定了“本地文件 + JSON”和“全局 + 每视频两份词表”，但没有落到具体路径与字段名。实现第一步前把这些定死，避免 CLI、核心库与后续界面各自发明一套。

## Status

已接受（accepted），落实 [ADR-0002](./0002-filesystem-and-json-storage.md)、[ADR-0005](./0005-llm-notes-pipeline-and-corrections.md)、[ADR-0007](./0007-core-library-cli-first-and-note-format.md)。

## 决定

- **notes 根目录**默认 `~/Documents/video-notes`，环境变量 `VNOTE_HOME` 覆盖。
- **每个视频一个输出目录**，目录名是“源文件名 slug + 视频 id 前 8 位”；id 由源文件绝对路径的 sha256 取前 8 位，重跑同一文件拿到同一目录。目录内每个主题一个子目录（`topic.md` 与该主题切片），外加 `index.md`。
- **纠错词表文件**是 JSON 数组 `[{"wrong": "识别错原文", "right": "正确写法"}]`；全局一份在 `<NOTES_ROOT>/corrections.json`，每视频一份在 `<视频目录>/corrections.json`，同一 `wrong` 冲突时视频专属生效。文件缺失视为空词表，格式错误直接报错。
- **不提供 `--out`**：输出目录在首次生成时确定，之后不随参数变化（ADR-0002）。
- **分块兜底**：窗口内找不到语音停顿时硬切在 15 分钟（`CHUNK_MAX_SECONDS`），这是唯一允许的硬切；有停顿就仍在停顿处切。
- **切片前移 2 秒**（`CLIP_PREROLL_SECONDS`），前移后重叠的时间段合成一个切片（切片产物形态见 [ADR-0026](./0026-single-file-topic-clip.md)）。

## 后果

- 目录名带 id，源文件名相同也不会互相覆盖；改标题只改 `index.json` 里的 `title`，目录不动。
- 视频目录里的 `.cache/` 存各步骤缓存，与产物同目录但独立，删掉只损失重算时间。
- 纠错词表写错一个字（`wrong` 拼错）不会报错，只会静默不命中；这是字面替换的已知代价（ADR-0005）。
