# 确认主题后再生成笔记

[ADR-0011](./0011-stale-topic-output-cleanup.md) 之后，`vnote extract` 一次跑完转写、划主题、生成全部主题笔记并写 `index.md`。主题由 LLM 划出，用户要剔除哪个、合并哪几个，要等全部笔记都生成完才能发现——不想要的主题也花了转写之外的全部 LLM 调用与切片时间，用户想跳过某主题只能事后手动处理。本 ADR 把导入拆成「划主题 → 用户确认 → 生成笔记」两段，划完就停。

## Status

已接受（accepted）。改变 [ADR-0011](./0011-stale-topic-output-cleanup.md)「整视频运行末尾清理」的触发点（现在导入时清理），目录布局、所有权哈希与保留集语义不变；`vnote topics`（重跑主题）与 `vnote notes` 的局部生成语义不变。

## 决定

- **导入在划完主题后停止。** `runExtract` 落 `video.json`（转写与分块）、划完主题后，把每个 `TopicRecord` 写成 `status: "proposed"`、`selected: true`、`clips: []`、`keyPoints: []`、`startedAt/elapsedSeconds/error` 为 `null`，然后直接返回：`notes: []`、`indexMarkdown: ""`、`topicCount = 主题数`、`noteCount = 0`，不再调用 `generateAll` / `writeIndexFromDoc`（`packages/core/src/pipeline/extract.ts`）。锁在 `finally` 正常释放；失败仍走 `settleRunWhileLocked`，只结算该次运行写的主题。
- **导入时清理旧产物。** 划完主题、写回 `video.json` 之前，调用 `sweepStaleTopicDirs({ outputDir, keep: [] })` 清掉工具自有的旧主题目录（用户改过 `topic.md` 的目录由 ADR-0011 的哈希保护保留），并删除旧的 `index.md`（`rmSync`，失败静默）。因为导入后不再写 `index.md`，保留集为空，上一轮的全部工具目录都是过期产物。
- **`proposed` 是持久态，不是中断残留。** 读侧投影 `projectRunState` 与 `settleRunWhileLocked` 都不动 `proposed`（`packages/core/src/core/video-data.ts`）：没有存活运行锁时，`proposed` 读出来仍是 `proposed`，不是「上次生成已中断」的 `failed`。
- **卡片状态新增两个档。** `deriveStatus`（`packages/core/src/core/library.ts`）判定顺序：任一主题 `failed`/`needs-rerun` → `needs-rerun`；无字幕 → `in-progress`；`selected` 主题非空且**全部**为 `proposed` → `pending-confirm`（卡片「待确认主题」，按钮「确认主题」）；`selected` 全部 `done` → `done`；`done` 数介于 0 与 `selected` 数之间 → `partial`（卡片「部分完成」）；其余 → `in-progress`。`listLibrary` 的 `busyVideoId` 仍只把 `done` 降级为 `in-progress`。
- **确认动作过滤已 done 主题。** `runNotes`（确认主题按钮提交的任务）先 `ids.filter((t) => t.status !== "done")`（`packages/core/src/pipeline/notes-run.ts`）：只对还没有笔记的主题生成；全部已 done 时返回 `noteCount: 0`、不报错，`index.md` 从完整文档重建。已 done 主题不进入 `generateNotes`，其 `topic.md` 与切片的 mtime 不变。主题页按钮「生成所选主题笔记 (N)」不变，仍提交全部 `selected` id，由 core 过滤。
- **`runTopics` 保持现状。** 重跑主题（`vnote topics`）重划后对全部主题生成，不等确认。

## Considered Options

- **全部生成后再删不想要的**：保留现状流程，用户确认后对剔除的主题删目录删条目。但剔除决定只能事后做，不想要的主题的 LLM 调用与切片时间已经花掉；删除还要再过一遍清理判定与 `index.md` 重建，等价于多跑一遍本次改动引入的清理逻辑。不采用。
- **导入时问用户要不要跳过生成**：把决定提前到导入时，但用户此时还没看到主题列表，跳过与否是盲选；且 CLI 场景没有交互面。把确认放在看到主题之后（桌面端主题页按钮）才是决定能做出的最早时点。不采用。
- **`proposed` 复用 `queued`，读时按「无笔记」投影**：不改状态枚举，但 `queued` 在既有语义里是「中断运行的残留」，投影与结算都会把它改 `failed`，读出来的状态和用户看到的卡片状态会打架。不采用。

## 后果

- 导入不再产出 `topic.md`、切片与 `index.md`：导入完的输出目录里只有 `video.json`（与缓存、`corrections.json`）。旧运行留下的工具目录与 `index.md` 在导入时就被清掉；用户改过 `topic.md` 的目录仍由哈希保护保留。
- 导入后重跑 `vnote extract`：上一轮已生成的主题目录（工具自有、未被用户改过）在导入时被当旧产物清掉，笔记需要重新生成；这是「划完就停」与 ADR-0011 保留集机制组合的必然结果。
- 桌面端导入完成后卡片进入 `pending-confirm`，用户勾选/取消主题后点「确认主题」才产生第一个笔记任务；确认时勾选了几个、已 done 的几个被过滤，只生成还没有笔记的。全部确认后卡片进 `done`，部分确认进 `partial`。
- 中断结算与读侧投影对 `proposed` 不敏感：进程被杀在划完主题之后，重启读到的是可继续确认的 `proposed`，不是 `failed`；用户重新确认后只生成未完成的。
- `vnote topics` 仍是一次跑完（重划 + 全部生成），不引入确认步骤；它是显式重跑入口，语义保持简单。
