# 导入时统一媒体规范化（转码/换封装）与单术语表入口

导入链路原本把用户选择的文件原样交给 ffprobe/ffmpeg/Chromium：`.ts`、`.mkv`、`.avi`、`.flv`、`.wma`、`.flac`、HEVC 等容器/编码只有在「ffmpeg 能解码」这一层被容忍，内置播放器却无法预览（r42 把 `.ts` 记为播放 caveat，r45 在播放器里加了一条 MPEG-TS 不可预览提示）。同一个视频因此存在两套事实：管线能处理、用户看不到画面。同时库卡片与字幕页各有一套「本视频专属术语表 + 重跑范围」入口，两处编辑同一份 `corrections.json`，用户不知道该在哪改。

## Status

已接受（accepted，2026-10-29，r45b）。取代 r42 的「`.ts` 源播放是记录性 caveat」口径，以及 r45 播放器里「所有 `.ts` 源都提示不可预览」的适用范围（只保留给旧数据回退）。

## 决定

1. **导入时先探测容器与编码。** `probeVideo` 在原有 duration/width/height/hasVideo 之外返回 `formatName`、`videoCodec`、`audioCodec`（ffprobe `format_name` 与首条视频/音频轨 `codec_name`）。决策是纯函数 `decideNormalization(probe)`，只依赖这四个字段与扩展名。
2. **直读矩阵。** 命中即 `normalized: "none"`，不产生新文件：
   - mp4/mov/m4v 容器：视频 `h264`/`vp9` + 音频 `aac`/`mp3`/`opus`；
   - m4a（或纯音频 mp4）：`aac`/`mp3`/`opus`；
   - `mp3`；`wav`（`pcm_*`）；`webm`（`vp8`/`vp9`/`av1` + `opus`/`vorbis`）。
3. **其余先规范化，再进入后续流程。** 产物固定放在该视频数据目录：
   - 有视频轨 → `media.mp4`：编码已是 `h264` + `aac` 时 `-c copy` 只换封装（`remux`）；否则 `libx264`（veryfast/crf 20/yuv420p）+ `aac` 192k 转码（`transcode`）。两条路径都带 `-movflags +faststart`。
   - 纯音频 → `media.mp3`：`libmp3lame`，VBR `-q:a 2`。
   - 先写 `*.part-<pid>`，成功后 rename；取消/失败不留半截产物。
4. **`video.json` 记录来源与产物。** 新增 `originalPath`（源绝对路径）、`mediaPath`（数据目录内的 `media.mp4`/`media.mp3`，只接受这两个文件名）、`normalized`（`none`/`remux`/`transcode`）。旧文档缺这三个字段读回 `null`，`mediaAbsolutePath(data)` 回退 `video.sourcePath` —— 原文件不动、不复制。
5. **所有下游统一读 `mediaPath`。** 内置播放器（`vnote-media://source/<id>` 解析到 `mediaPath ?? sourcePath`）、ASR 抽音、主题切片（`cutClip`）、封面抽帧、封面后台补齐都用规范化产物。重跑时产物已存在则复用，丢失才重新规范化。
6. **音轨预检仍在规范化之前。** `assertAudioDecodable` 在 `openVideo`（建目录）之前跑：坏音轨的 `.ts` 在产生任何文件与库条目之前就以 `音轨无法解码（…）` 拦下，不会被一次注定失败的转码拖住。
7. **「格式转换」是独立任务步骤。** `Progress.step` 新增 `normalize`，按 ffmpeg `time=` 相对总时长报 0–99%，日志记 `格式转换开始/完成/失败` 与 `格式转换跳过/复用已有产物`；取消沿用 `killActiveChildren`（杀 ffmpeg 子进程，worker 退出后落终态）；失败消息以 `格式转换失败（换封装|转码）：` 开头并附 ffmpeg stderr 尾部。
8. **术语表入口收敛到字幕页。** 库卡片不再有「本视频专属术语表」编辑块与「修改后选择重跑范围」按钮；字幕页术语表下方保留唯一的编辑 + 重跑范围入口（仅重新生成主题 / 连同语音重新转写）。两处原先写同一份文件，收敛不损失功能。

## Considered Options

- **导入时一律转码成 h264+aac**：口径最简单，但每个 mp4 都要重编码（长视频数分钟到数十分钟 CPU），且会损失画质/体积。用直读矩阵把绝大多数常见来源留在零拷贝路径。
- **保留 `.ts`/`.mkv` 原样 + 只在播放器里提示**：管线能跑，但用户永远看不到画面；r42/r45 的 caveat 就是在给这个缺口打补丁。规范化把「能处理」和「能预览」合成一件事。
- **在播放器里做容器转换（`MediaSource`/WebCodecs）**：Chromium 对 MPEG-TS 无 demuxer，需要在 renderer 里实现 TS demux，成本与风险远高于一次性 ffmpeg。
- **规范化产物放缓存目录**：缓存可被「清理缓存」删除，而 `mediaPath` 是播放/切片的唯一事实源；放数据目录与 `cover.jpg`、主题目录同级，删除视频时一并清掉。
- **`mediaPath` 存绝对路径**：notesRoot 可在设置里切换，数据目录会整体搬动；存相对数据目录的文件名让文档跟着目录走。

## 后果

- 导入耗时在需要转换的来源上增加一次 ffmpeg 全片处理；直读来源不变。任务浮层的「格式转换」步骤给出可见进度，可取消，失败有明确报错。
- 旧数据（没有 `mediaPath`）行为不变：播放、切片、封面继续用原文件；`.ts` 的「MPEG-TS 不支持内置预览」提示只在这种回退场景出现，规范化后的 `.ts` 不再提示。
- `media.mp4` 与 `media.mp3` 与 `cover.jpg` 一样由删除视频一并清理；用户原文件仍不受影响。
- `video.json` 版本不变（仍是 1，新增字段可缺省），旧文档无需迁移即可读。
- 格式矩阵文档（features/media-formats.md）与 r45 的 `.ts` 播放提示食谱按本 ADR 更新。
