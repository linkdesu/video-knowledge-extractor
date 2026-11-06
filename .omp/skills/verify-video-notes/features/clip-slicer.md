# Clip slicer project queues (#126)

整理切片把项目里的来源视频按分块增量分析：一个字幕解析 + 主题分析任务只负责「一个文件的一个区间」，字幕与主题追加进视频库共享的 `video.json`，主题以 `proposed`（待确认）出现；自动切片开启时，每个主题再由切片任务产出到 `<项目目录>/clips/<序号>-<标题>.mp4`。两条队列全局各一个任务，可以同时各跑一个，同一个视频用运行锁互斥。界面由 #127（项目列表/外框）、#128（项目配置）、#142（队列 tab）、#130（切片产出）接入；单主题确认弹窗属 #143。本页覆盖执行器、数据契约与已落地的队列 tab。

## Sub-features

- `project-analysis-range`: 一个分析任务 = 一个来源文件的一个区间。管线先 probe、注册视频（`index.json`/`video.json`）、按 ADR-0033 规范化格式，然后只抽这一段的音频、只转写这一段、只划这一段的主题。已有区间由控制器 cursor 挡住，不重跑；`video.json` 的 `chunks` 追加区间，字幕时间戳平移回源时间轴，主题时间段夹回本区间。
- `project-shared-library`: 项目视频就是普通视频；字幕、主题、缓存目录与视频库共用。主题状态沿用 `proposed / queued / generating / done / failed`，不新增状态。
- `project-two-lanes`: 所有项目共用一个 `ProjectRuntime`：analysis 槽串行跑区间分析，slice 槽串行跑主题切片；两条槽可以同时跑，不同视频互不等待。
- `project-video-lock`: 同一个视频的分析与切片共用 `.vnote-run.lock`；后到的一方等前一方释放，不会并行写同一个 `video.json`。
- `project-slice-record`: 切片复用 ADR-0026 的规划、切割与拼接，落到 `<项目目录>/clips/`；序号由 `ProjectService.beginClip` 在途占位、`endClip` 落盘推进计数器，失败 `abortClip` 不消耗序号、不复用已落盘序号。
- `project-clip-boundary`: 项目切片的 `segmentIndexes`/`segmentOffsets` 指向记录自带的字幕片段表（`segments`），不是主题段；播放定位、删段重映射、`done` 产物投影都按 `segments` 是否存在区分。项目切片在项目目录，不按 `topic.mp4` 判断缺失。
- `project-queue-tab`: 「整理切片 / <项目> / 切片队列」分三块：字幕解析 + 主题分析（每块两步，只显示等待中 / 进行中 / 已完成，无百分比）、待确认主题（「确认字幕」入口，不自动弹窗、不占队列）、切片。标题旁 tag 显示「分析 N · 切片 N」（只数未完成），都空闲时「队列空闲」。底部按视频列出「未切片内容时长 HH:MM:SS」。阶段 1 由 `ProjectRuntime` 把管线 `segment-topics` 进度映射成控制器 `advanceAnalysisStage(1)` 并立即推送详情。

## How to get to it (user POV)

左侧「整理切片」→ 进入项目 → 「切片队列」tab。项目还没有视频时显示「队列空闲」与三个空态；加入视频并「开始整理」后，分析块立即出现并推进两步（转写 → 主题分析）；自动切片关闭时，主题停在「待确认主题」区（每行一个「确认字幕」按钮，不自动弹窗、不计入任务）；打开自动切片后主题变成串行切片任务；全部切片完成后底部每个视频显示「未切片内容时长 00:00:00」。驱动路径之外，main 进程的 `ProjectRuntime` + `ProjectService` 仍是唯一真相源：项目被列表/详情读取时懒建控制器，「开始整理」的 IPC 先按路径注册目录里的新文件，再进控制器排队。

## Driving it with verify.ts

```bash
V="bun .omp/skills/verify-video-notes/scripts/verify.ts drive"

$V click '[data-testid=nav-slicer]'
$V fill '[data-testid=project-create-name]' 'r89 队列验收'
$V fill '[data-testid=project-create-root]' '/abs/path/项目目录'      # 目录要存在
$V click '[data-testid=project-create]'

# 空态：三条空文案 + 队列空闲 + 未切片内容时长占位
$V click '[data-testid=project-tab-queue]'
$V eval "({ count: document.querySelector('[data-testid=queue-count]').textContent, foot: document.querySelector('[data-testid=queue-foot]').textContent })"

# 关自动切片 → 监控一个含 30 秒短片的目录 → 勾选 → 开始整理
$V click '[data-testid=project-auto-slice]'
$V click '[data-testid=project-tab-config]'
$V fill '[data-testid=project-monitor-directory]' '/abs/path/recordings'
$V click '[data-testid=project-monitor-start]'
$V wait "document.querySelectorAll('[data-testid=project-file-checkbox]').length > 0"
$V click '[data-testid=project-file-checkbox]'
$V click '[data-testid=project-organize-start]'
$V click '[data-testid=project-tab-queue]'

# 两步：转写进行中 → 主题分析进行中 → 两步已完成；待确认主题出现但不占队列
$V wait "document.querySelector('[data-testid=analysis-stage][data-state=running]')?.dataset.stage === '主题分析'" --timeout 240000
$V wait "document.querySelector('[data-testid=analysis-task-status]').textContent === '已完成'" --timeout 240000
$V eval "({ count: document.querySelector('[data-testid=queue-count]').textContent, entries: document.querySelectorAll('[data-testid=pending-topic-confirm]').length })"

# 打开自动切片 → 切片任务串行完成 → 底部长时长归零
$V click '[data-testid=project-auto-slice]'
$V wait "document.querySelectorAll('[data-testid=slice-task]').length > 0" --timeout 30000
$V wait "document.querySelector('[data-testid=queue-count]').textContent === '队列空闲' && document.querySelector('[data-testid=queue-foot]').textContent.includes('00:00:00')" --timeout 240000
```

稳定句柄：`queue-count`（tag）、`queue-analysis` / `queue-pending` / `queue-slices`（三个区）、`analysis-task`（`data-job-id`）、`analysis-task-status`、`analysis-stage`（`data-stage=字幕解析|主题分析`、`data-state=waiting|running|done|failed`）、`pending-topic`（`data-topic-key`）、`pending-topic-confirm`、`slice-task`（`data-slice-id`）、`slice-task-status`、`queue-foot`。

本票的证据是：

```bash
cd packages/core && bun test src/core/project-controller.test.ts      # 两步推进只前进不回退、失败终态
cd apps/desktop && bun test src/main/project-runtime.test.ts          # 阶段回调即时推送、双槽并发
cd apps/desktop && bun test src/renderer/src/lib/project-queue.test.ts  # 计数 / 两步 / 底部长时长文案
```

`tmp/verify/r81-dual-queue/smoke.ts` 仍是真实 ffmpeg + 本地 sherpa ASR + 固定 LLM 答复的冒烟脚本。

## Gotchas

- 真实 LLM 一次只看到本区间的字幕（绝对时间）。模型若返回区间外时间段（例如误用相对时间），管线会夹回区间；夹不出有效段就丢弃，不会串到别的区间。
- 运行锁由 `ProjectRuntime` 先取再传给 `analyzeVideoRange`（`lock` 参数），避免同一进程二次取锁失败。
- `startOrganize` 接受监控目录里的新文件：main 的 IPC 先 `registerSources`（按路径 ffprobe 元数据），再走控制器；已导入视频库的文件直接复用库元数据。
- 队列 tab 的「确认字幕」入口在 #142 只就位不打开弹窗；弹窗交互、字幕行勾选与生成切片属 #143。
- 停止增长 30 秒的实时轮询、增长中文件、重启后的 cursor 恢复属于 #132；当前完整文件按「停止增长已超过 30 秒」立即入尾段。
- 每段前是否多留 2 秒仍按 `CLIP_PREROLL_SECONDS = 2`（ADR-0056 Open Question），等 Link 拍板；改口径会同时影响段偏移。
