# video-notes

从视频提取语音转写（SRT/JSON）、关键帧和带图结构化笔记的原型。全部走本地 OpenAI 兼容接口，不依赖云端。

```bash
# 依赖：bun、ffmpeg/ffprobe；本地服务默认 http://127.0.0.1:9527/v1
bun run extract <视频文件或目录> [--limit 300] [--out runs/demo]

# 只跑转写+关键帧
bun run extract <video> --skip-notes
```

产物（运行目录）：

| 文件 | 内容 |
|---|---|
| `transcript.srt` / `transcript.json` | 带时间戳字幕（分段转写合并） |
| `frames/` + `frames/index.json` | dHash 去重后的关键帧 |
| `notes.md` / `notes.html` | 按主题分段的带图笔记（HTML 图片 base64 内嵌） |
| `run.json` | 参数、各阶段耗时、统计 |
| `cache/` | 音频、切片、ASR/笔记缓存；重跑直接复用（`--force` 重做） |

常用参数：`--limit` 秒数、`--target-chunk`/`--max-chunk` 切片长度、`--max-frames`、`--window` 笔记窗口、`--llm-concurrency`、`--glossary`（默认读取当前目录 `glossary.json`；格式见 `glossary.example.json`，`__prompt__` 会作为 ASR 上下文，键值做兜底替换）。

`notes.html` 的每节时间戳链接到本地视频的 `#t=秒`，可直接跳转播放。

环境变量：`ASR_BASE_URL`、`ASR_MODEL`、`LLM_BASE_URL`、`LLM_MODEL`、`ASR_API_KEY`、`LLM_API_KEY`。

方案与取舍见 `tmp/handoff/plan.md`，实测报告见 `tmp/report/r1-原型报告.md`。
