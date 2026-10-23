# 主题切片拼接为单文件

一个主题有多个互不连续的时间段时，旧方案（ADR-0008 第 16 条）按时间段各切一个 mp4，前移后重叠的时间段合成一个，于是每个主题对应一到多个编号切片文件（`01-00-13-53-00-16-24.mp4` 形态）。多切片带来三处麻烦：笔记页与主题页要为每个切片各挂一个播放器或一段源视频区间；`topic.md` 与 `index.md` 里一个主题对应多条链接；播放器按源时间轴跳转时，切片时间轴与源时间轴是两套坐标，字幕跳转要按切片分别算。本 ADR 把每个主题切成**一个** `topic.mp4`，所有时间轴问题收敛成一份持久化的段偏移表。

## Status

已接受（accepted）。改变 [ADR-0008](./0008-local-layout-corrections-file-and-cli-boundary.md) 第 16 条的切片产物形态（前移由 3 秒改为 2 秒）与切片命名；[ADR-0011](./0011-stale-topic-output-cleanup.md) 的目录判定扩展为同时接受 `topic.mp4` 与旧编号切片，所有权与保留集语义不变。

## 决定

- **每主题一个 `topic.mp4`。** `CLIP_PREROLL_SECONDS` 由 3 改为 2（`packages/core/src/core/config.ts`）。新文档每个主题只写**一条** `TopicClip` record：`{ file: "topic.mp4", start: 第一个 union 的 start, end: 最后一个 union 的 end, segmentIndexes: 全部原段下标, segmentOffsets: [...] }`（`packages/core/src/core/video-data.ts`）。`segmentOffsets.length === topic.segments.length`，`segmentOffsets[i]` 是第 i 段起点在拼接文件里的秒数偏移（含 2 秒前移与合并）。
- **偏移怎么算。** `planTopicClip`（`packages/core/src/core/clips.ts`）复用 `planClips` 语义（排序、前移、重叠或相接合并）得到 `unions`；对每个原段 i，取其前移后的区间 `[max(0, start_i - 2), end_i]`，找到覆盖它的 union j，偏移 = 它前面所有 union 的时长之和 + 段起点在 union j 内的偏移；无匹配（不应发生）为 0。
- **怎么拼。** `generateNotes` 单主题流程（`packages/core/src/pipeline/generate-notes.ts`）：对每个 union 用既有 `cutClip`（重编码保证帧精确）切到系统临时目录（`mkdtemp` 的 `vnote-clip-*`，文件名按 union 下标），再 `concatClips`（`packages/core/src/core/clips.ts`）产出 `<主题目录>/topic.mp4`：1 个 part 直接 `renameSync`；多个 part 写 ffmpeg concat 列表（`file '<绝对路径>'`，单引号转义为 `''`），`ffmpeg -f concat -safe 0 -map 0:v:0 -map 0:a? -c copy -movflags +faststart` 先写 `.part-<pid>.mp4` 成功后 rename，失败清理临时文件。拼接成功后删掉该主题目录里旧编号切片（`SLICE_RE` 匹配的 `*.mp4`，不含 `topic.mp4`）与临时目录。已有的 `topic.mp4` 一律重写——生成即代表需要新产物；[ADR-0025](./0025-generate-notes-after-topic-confirmation.md) 保证已 done 的主题不会走到这里，所以已确认产物的 mtime 稳定。
- **目录判定与清理接受 `topic.mp4`。** `isToolTopicDir`（`packages/core/src/core/outputs.ts`）允许 `topic.mp4` 与旧编号切片，至少一个 mp4 即纯工具目录；manifest 逻辑不变。
- **渲染与跳转。** `renderTopicMarkdown` 的段标题链接、`index.md` 的每个主题只链 `topic.mp4` 一次。播放端用 `clipSeekTarget`（`apps/desktop/src/renderer/src/lib/playback.ts`）按偏移跳转：主题只有一个带 `segmentOffsets` 的切片时播 `topic.mp4`，段标题跳到 `segmentOffsets[i]`，字幕行跳到 `offsets[i] + (字幕时间 - 段起点)`；无切片回退源视频按源时间播放。
- **结构编辑同步偏移。** `edits.ts` 的 `deleteTopicSegment` 删段后同步裁剪 `segmentOffsets` 并重映射 `segmentIndexes`；`mergeTopics` 清空 clips 现状不变；`rerender` 透传 `segmentOffsets`。
- **读侧与旧文档。** `parseClips` 读 `segmentOffsets`，缺失或非法记为 `[]`（`packages/core/src/core/video-data.ts`）。文档缺失时的目录反推迁移只解析编号切片（按切片文件名恢复时间段），`topic.mp4` 不参与——旧目录里没有段偏移，反推不出来。渲染层遇到 `clips.length > 1` 或无 `segmentOffsets` 的旧文档按旧行为降级（源视频 + 区间，或多切片），不崩。
- **IPC。** `ClipInfo` 增加 `segmentOffsets: number[]`（`apps/desktop/src/shared/ipc.ts`），main DTO 传 `c.segmentOffsets ?? []`；`library.ts` 的 `clipCount` 保持 `sum(clips.length)`，新文档下每主题计 1。

## Considered Options

- **保持多切片，只把播放层的时间轴换算做好**：每个切片独立文件不变，播放器仍要按切片分别计算跳转，`topic.md`/`index.md` 的链接数不变；换算逻辑分散在播放、笔记、索引三处。单文件把时间轴换算收敛成一份持久化的 `segmentOffsets`。不采用。
- **整段一次切、不拼接**：多个不连续时间段没法用一次 ffmpeg 切出一个文件；用 `select`/分段 concat 绕一圈，等于自己重写 ffmpeg 的 concat 滤镜。按 union 各切一次（帧精确重编码）+ 流拷贝拼接是 ffmpeg 的既有能力。不采用。
- **拼接也重编码（统一转码）**：每个 part 已经重编码过（`cutClip`），流拷贝拼起来不损帧精度；再转一遍只多花时间与损耗。不采用。
- **把 `topic.mp4` 也参与旧目录反推**：旧目录里的 `topic.mp4` 没有段偏移与段对应关系（旧文档里它可能根本不存在），按文件名反推不出 `start/end` 与覆盖；反推仍只认编号切片，`topic.mp4` 出现时说明文档里已有 record，不需要反推。不采用。

## 后果

- 新数据的切片文件是每个主题一个 `topic.mp4`；旧编号切片只存在于旧数据里，目录判定（`SLICE_RE` 与 `topic.mp4` 并存仍是纯工具目录）、反推迁移、渲染降级都保留对旧数据的兼容。
- 已 done 主题的 `topic.md` 与 `topic.mp4` 在确认生成（[ADR-0025](./0025-generate-notes-after-topic-confirmation.md) 的 `runNotes` 过滤）中 mtime 不变；`topic.mp4` 被重写只发生在该主题真正重新生成时。
- 拼接是流拷贝（`-c copy`）：每个 part 由 `cutClip` 重编码，格式一致，拼接不重编码；单个 union 的 part 直接 rename 成 `topic.mp4`。
- 播放与字幕跳转走同一份 `segmentOffsets`：段标题、字幕行、笔记页 chips 都是「偏移 + 段内相对时间」，不再有「切片时间轴 vs 源时间轴」两套坐标的分支（旧文档降级除外）。
- 切片前移 2 秒（原 3 秒）：前移更短，相邻时间段的 union 合并行为不变（仍按前移后重叠或相接合并），只是覆盖的边界内容略少。
