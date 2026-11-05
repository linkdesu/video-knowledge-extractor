# Clip slicer project queues (#126)

整理切片把项目里的来源视频按分块增量分析：一个字幕解析 + 主题分析任务只负责「一个文件的一个区间」，字幕与主题追加进视频库共享的 `video.json`，主题以 `proposed`（待确认）出现；自动切片开启时，每个主题再由切片任务产出到 `<项目目录>/clips/<序号>-<标题>.mp4`。两条队列全局各一个任务，可以同时各跑一个，同一个视频用运行锁互斥。界面（项目列表、三个 tab、确认弹窗）由 #127–#130 接入，本页只覆盖已经落地的执行器与数据契约。

## Sub-features

- `project-analysis-range`: 一个分析任务 = 一个来源文件的一个区间。管线先 probe、注册视频（`index.json`/`video.json`）、按 ADR-0033 规范化格式，然后只抽这一段的音频、只转写这一段、只划这一段的主题。已有区间由控制器 cursor 挡住，不重跑；`video.json` 的 `chunks` 追加区间，字幕时间戳平移回源时间轴，主题时间段夹回本区间。
- `project-shared-library`: 项目视频就是普通视频；字幕、主题、缓存目录与视频库共用。主题状态沿用 `proposed / queued / generating / done / failed`，不新增状态。
- `project-two-lanes`: 所有项目共用一个 `ProjectRuntime`：analysis 槽串行跑区间分析，slice 槽串行跑主题切片；两条槽可以同时跑，不同视频互不等待。
- `project-video-lock`: 同一个视频的分析与切片共用 `.vnote-run.lock`；后到的一方等前一方释放，不会并行写同一个 `video.json`。
- `project-slice-record`: 切片复用 ADR-0026 的规划、切割与拼接，落到 `<项目目录>/clips/`；序号由 `ProjectService.beginClip` 在途占位、`endClip` 落盘推进计数器，失败 `abortClip` 不消耗序号、不复用已落盘序号。
- `project-clip-boundary`: 项目切片的 `segmentIndexes`/`segmentOffsets` 指向记录自带的字幕片段表（`segments`），不是主题段；播放定位、删段重映射、`done` 产物投影都按 `segments` 是否存在区分。项目切片在项目目录，不按 `topic.mp4` 判断缺失。

## How to get to it (user POV)

当前没有界面入口（#127 项目列表、#128 项目配置、#129 队列与确认弹窗、#130 切片产出）。落地的路径是 main 进程的 `ProjectRuntime` + `ProjectService`：项目被列表/详情读取时懒建控制器；「开始整理」的 IPC 走 runtime，先解析视频库元数据再进控制器排队。

## Driving it with verify.ts

还没有 UI 驱动路径。等 #131 阶段 1 端到端验收时补 `drive` 步骤。本票的证据是：

```bash
cd packages/core && bun test src/pipeline/project-analysis.test.ts   # 区间增量、时间轴偏移、区间夹取
cd apps/desktop && bun test src/main/project-runtime.test.ts          # 双槽并发、同视频互斥、切片落盘与计数
cd apps/desktop && bun test src/main/projects.test.ts                 # 冒号主题、序号在途占位/失败不消耗、持久化
bun tmp/verify/r81-dual-queue/smoke.ts                                # 真实 ffmpeg + 本地 sherpa ASR + 固定 LLM 答复
```

`smoke.ts` 只用 `~/Documents/video-notes/r42-fixtures/r42-src-30s.mp4`，产物与 `state.json` 都在 `tmp/verify/r81-dual-queue/`。`state.json` 必须有两个区间、字幕行数大于 0、至少一个 `proposed` 主题、`clips/` 里一个非空 mp4。

## Gotchas

- 真实 LLM 一次只看到本区间的字幕（绝对时间）。模型若返回区间外时间段（例如误用相对时间），管线会夹回区间；夹不出有效段就丢弃，不会串到别的区间。
- 运行锁由 `ProjectRuntime` 先取再传给 `analyzeVideoRange`（`lock` 参数），避免同一进程二次取锁失败。
- `startOrganize` 只接受视频库里的 id；新文件仍需先走现有导入拿到 id（界面流程在 #128）。
- 停止增长 30 秒的实时轮询、增长中文件、重启后的 cursor 恢复属于 #132；当前完整文件按「停止增长已超过 30 秒」立即入尾段。
- 每段前是否多留 2 秒仍按 `CLIP_PREROLL_SECONDS = 2`（ADR-0056 Open Question），等 Link 拍板；改口径会同时影响段偏移。
