# 桌面端界面按 UX 原型逐页重做

r20/r21 的桌面端界面是自行设计的，没有引用 Link 已确认的 UX 原型。本轮以原型为准重做界面，并把原型要求但 core 没有的业务能力补进 core：结构化字幕与主题（`video.json`）、主题合并、删除单条字幕/整段、主题级生成进度与耗时、可编辑的存储与模型目录。

权威原型是 `tmp/artifacts/r8-ux-prototype-v4/`（`prototype.html` + `screenshots/01–06`）。v4 未覆盖的页面与规则取 `tmp/artifacts/r7-ux-prototype-v3/`（`screenshots/01–08`）。两者都只读，不改。

## Status

已接受（accepted）。取代 [ADR-0013](./0013-react-bits-pro-renderer.md) 的落位表（组件获取方式与 license 规则不变），并落实 [ADR-0012](./0012-electron-desktop-utility-process.md) 的「界面只调 core」。

## 决定

### 1. 原型决定清单

下表中「brief」是 r22 任务书，「v3 #N」「v4 #N」是两份 `changes.md` 的批注编号。每一条都必须在实现里成立。

| # | 决定 | 来源 |
|---|---|---|
| 1 | 任何地方都没有「导出」；文件直接去输出目录看 | brief、v3 #1 |
| 2 | 顶栏没有就绪状态、没有头像，只留面包屑 | brief、v3 #2 |
| 3 | 没有单独导入按钮；导入合并进拖放区，点击或拖放都导入 | brief、v3 #3 |
| 4 | 视频卡片按状态显示按钮：未完成「继续编辑」进主题页，已完成「查看笔记切片」进笔记页 | brief、v3 #4 |
| 5 | 合并主题：点「合并主题」才出现「选入合并」复选框与「确认合并 (n)」/「取消」；默认不显示复选框 | brief、v3 #5 |
| 6 | 主题页原始字幕按段分组，每段自己的时间范围；真实数据允许 2–3 段以上 | brief、v3 #6、v4 #1 |
| 7 | 可删单条字幕，也可删整段；至少保留一段 | brief、v3 #7 |
| 8 | 笔记页没有完整原视频播放器；每个 segment 的 clip 下方显示该段字幕 | brief、v3 #8、v4 #3 |
| 9 | 笔记页右侧主题列表是「列表 + 按钮」（「查看笔记」），不是整卡大按钮；左侧详情随按钮切换 | brief、v4 #4 |
| 10 | 笔记页点击字幕跳转/定位对应 clip，并显示「已跳到 mm:ss」 | brief、v4 #3 |
| 11 | 主题页右侧主题列表是「列表 + 按钮」（「查看字幕」），不是整卡大按钮 | brief、v4 #2 |
| 12 | 生成中的主题在列表和详情都显示进度条、已用时间、百分比 | brief、v4 #5 |
| 13 | 输出目录以纯文本显示在「打开输出目录」按钮旁，不加框 | brief、v4 #6 |
| 14 | 没有 S1/S2 说话人标签；说话人面板只有颜色点与姓名输入框 | brief、v3 #12（说明句删除）、v4 #7 |
| 15 | 设置页 notes / 缓存 / 模型目录都是输入框 + 「选择…」按钮 | brief、v3 #11 |
| 16 | 术语表页没有「编辑输入框后失焦即保存…」说明句 | brief、v3 #12 |
| 17 | 视频库卡片下方没有「视频术语表 ▾」提示行；点卡片标题展开术语表 | brief、v4 #8 |
| 18 | 视频库卡片状态用「已完成」口径；已完成卡片按钮是「查看笔记切片」 | v4 #9 |
| 19 | 面包屑按页面层级：`视频库`；`视频库 / 视频名 / 字幕`；`/ 主题`；`/ 笔记`；`视频库 / 术语表`；`设置` | v4 #10 |
| 20 | 主题多段合并规则：`segments` 取并集并排序；`next.start < prev.end + 0.5` 就合并（任意重叠都合，间隔 < 0.5s 吸收，恰好 0.5s 不合并），不补 gap | v3「保留/说明」 |
| 21 | 主题页左侧是播放器 + 该主题按段分组的原始字幕；主题详情含全部时间段 | v3 #6、v3 #10 |
| 22 | 笔记页左侧是笔记标题、全部时间段、要点，下面是分段 clip | v3 #10、v4 #3 |
| 23 | 笔记页右侧列表状态为 完成 / 生成中 / 排队，生成中带进度与已用时间 | v3 #9、v4 #5 |
| 24 | 字幕页保留播放器、字幕列表、说话人面板、本视频术语表；播放器随字幕定位 | v3 #2、v4 #7 |
| 25 | 设置页保留语音转写、总结分析、存储、关于四块；API key 只显示已保存 | v3 #11、v4 |
| 26 | 术语表页列为 识别结果 / 正确写法 / 来源 / 修改时间，编辑即时保存 | v3 #12、v4 |
| 27 | 修改术语表后可「修改后选择重跑范围」：仅主题和笔记，或连同语音重新转写 | v3、v4 原型 |
| 28 | 主题勾选框决定「生成所选主题笔记 (n)」的范围；主题可含多个不连续时间段 | v3、v4 原型 |
| 29 | 视频库拖放区文案「点击或拖放视频到这里」，支持 mp4 / mov，仅本地文件 | v3 #3、v4 |
| 30 | 顶栏、侧栏、卡片、列表、进度条、对话框的视觉结构照原型（暗色、aurora 背景、圆角卡片、纯紫 `#7c3aed` 主按钮；渐变只用于背景、渐变文字和进度条） | v4 原型 |
| 31 | 字幕页字幕随播放高亮并自动滚动；用户手动滚动后暂停自动滚动，点行仍定位 | v4 原型 |
| 32 | 笔记页点字幕后的高亮与该 clip 标题的「已跳到 mm:ss」持续显示，直到下一次定位或切换主题（没有超时） | v4 #3、v4 原型 |
| 33 | 「开始主题分析 →」只切到主题页；真正跑分析的是主题页的「生成所选主题笔记 (n)」 | v4 原型 |
| 34 | 合并主题的确认是页内「确认合并 (n)」/「取消」，不做弹窗；弹窗只用于「选择重跑范围」 | v4 原型 |

### 2. 页面与路由

renderer 仍不引路由库，路由是一个可判别联合，存在 `App.tsx` 的 state 里：

```ts
type Route =
  | { name: "library" }
  | { name: "video"; videoId: string; page: "transcript" | "topics" | "notes" }
  | { name: "glossary" }
  | { name: "settings" };
```

- 侧栏三项：视频库、术语表、设置。侧栏高亮规则照原型：视频内部的三个页面仍高亮「视频库」。
- 面包屑由路由推导，不在页面里写死：

```ts
const crumb = {
  library: "视频库",
  transcript: `视频库 / ${title} / 字幕`,
  topics: `视频库 / ${title} / 主题`,
  notes: `视频库 / ${title} / 笔记`,
  glossary: "视频库 / 术语表",
  settings: "设置",
};
```

- 视频卡片跳转：`继续编辑` → `{name:"video", page:"topics"}`；`查看笔记切片` → `{name:"video", page:"notes"}`。主题 → 笔记、字幕 → 主题由页面内步骤条（① 字幕 ② 主题 ③ 笔记）切换。
- 关闭/返回视频：面包屑「视频库」可点。

### 3. 状态模型

界面状态分三层，避免把服务端状态抄进组件：

1. **服务端状态**（IPC）：库列表、视频详情（`video.json` 投影）、设置。`useLibrary()` 在挂载时、任务进入终态时刷新；`useVideoDetail(videoId)` 在打开视频、任务终态、编辑成功时刷新。
2. **任务状态**：`extract:event` 推送的 `JobSnapshot`，`App` 持有。视频内的主题状态以 `video.json` 为准，生成中的百分比与已用时间由实时快照叠加（`job.detail` 是当前主题标题）。
3. **界面状态**（页面局部 `useState`）：当前选中的主题/笔记、合并模式与勾选、字幕定位点、对话框开关、导入进度。刷新详情后按主题 id 保留选择。任务运行中每 1 秒按 `topicId` 刷新一次详情，让主题状态从 `queued` 走到 `generating` 再走到 `done`，而不是等任务结束才更新；所有终态（成功/失败/取消）都刷新库与当前视频。

### 4. 组件树

```
App
├─ AppFrame                    (rbp app-shell-1 改造：侧栏 + 面包屑顶栏 + 内容槽)
│  ├─ SidebarNav               视频库 / 术语表 / 设置
│  └─ Breadcrumb
├─ LibraryPage                 (app-shell-1 卡片区改造)
│  ├─ DropZone                 (rbp empty-state-5：点击或拖放导入)
│  ├─ VideoCard[]
│  │  ├─ Thumb (渐变占位 + 时长)
│  │  ├─ StatusTag + ActionButton
│  │  ├─ ProgressBar           (转写中)
│  │  └─ VideoGlossaryPanel    (点标题展开；data-table-3 的行原语)
│  └─ RerunScopeDialog         (仅主题和笔记 / 连同语音)
├─ VideoWorkspace              (rbp app-shell-6 改造：步骤条 + 左详情右列表)
│  ├─ StepBar
│  ├─ TranscriptPage
│  │  ├─ Player                (源视频，vnote-media 源流)
│  │  ├─ SubtitleList          (点行定位)
│  │  ├─ SpeakerPanel          (颜色点 + 姓名输入)
│  │  └─ VideoGlossaryPanel
│  ├─ TopicsPage
│  │  ├─ TopicDetail           (标题、全部时间段、按段分组字幕 + 删除)
│  │  ├─ TopicList             (勾选框 + 「查看字幕」按钮；合并模式加「选入合并」)
│  │  └─ MergeBar              (合并主题 / 取消 / 确认合并 (n))
│  └─ NotesPage
│     ├─ NoteDetail            (标题、时间段、要点、进度+已用)
│     ├─ ClipBlock[]           (clip 播放器 + 该段字幕 + 定位)
│     └─ NoteList              (状态 + 「查看笔记」按钮)
├─ GlossaryPage                (data-table-3 改造：四列表格、内联编辑)
├─ SettingsPage                (settings-form-1 原语：四张面板)
├─ JobProgress                 (rbp monitoring-9：任务浮层)
└─ Toast                       (手写，本地没有 RBP toast)
```

### 5. 原型元素 → React Bits Pro 组件

不新增 vendor 条目：本轮不需要联网，也不需要 license 之外的资源。现有 7 个 pro 条目按「源码可改」重排用途。

| 原型区域 | RBP 条目 | 用法 |
|---|---|---|
| 侧栏、品牌、面包屑顶栏、内容壳 | `app-shell-1` | 改造成 `AppFrame`，删除统计块与旧导航 |
| 视频库卡片网格、状态标签、按钮 | `app-shell-1` 的 frame / ghostButton 原语 | 卡片换成原型结构（缩略图 + 元信息 + 状态 + 单按钮） |
| 视频库拖放/点击导入区 | `empty-state-5` | 去掉 LuminousType，改成「⇪ 点击或拖放视频到这里」 |
| 字幕页 / 主题页 / 笔记页的两栏工作区 | `app-shell-6` | 改造成 `VideoWorkspace`（步骤条 + 左详情 + 右列表） |
| 生成进度条、已用时间 | `monitoring-9` 的 `ProgressBar` | 导出为共用 `ProgressBar`，任务浮层继续用 `JobProgress` |
| 术语表表格（全局） | `data-table-3` | 四列表格 + 内联 input + 新增行 + 即时保存 |
| 本视频术语表（视频库展开、字幕页右栏） | `data-table-3` 的行原语 | 两列（识别 / 正确）+ 删除 |
| 设置页四张面板、字段行、路径 + 选择按钮 | 手写结构 + `styles.css` 的 `--rb-*` 令牌 | 本地 RBP 条目里没有可复用的设置块（`settings-form-1` 改造后没人引用，已删） |
| 确认合并、重跑范围对话 | 手写面板 + 遮罩 | 本地没有 RBP dialog 条目 |
| Toast | 手写 | 本地没有 RBP toast 条目 |
| 旧统计卡 `bento-29`、空态灯光标题 `luminous-type` | 删除 | 原型没有这两个元素，`reactbits.json` 同步删条目 |

### 6. 数据模型：`<outputDir>/video.json`

今天字幕、主题、切片归属只在内存里，落盘的只有 markdown 与切片文件名，界面无法重建字幕页、无法按段删除、无法合并主题。新增一个版本化文档，作为字幕与主题的唯一事实来源；`topic.md`、`index.md`、切片文件是它的派生产物，每次结构变化后由 core 原子重写。

```ts
// packages/core/src/core/video-data.ts
export const VIDEO_DATA_FILE = "video.json";
export const VIDEO_DATA_VERSION = 1;

export type TopicStatus = "queued" | "generating" | "done" | "failed" | "needs-rerun";

export type TopicClip = { file: string; start: number; end: number };

export type TopicRecord = {
  id: TopicId;
  title: string;
  summary: string;
  segments: Segment[];          // 已排序，可多段、可不连续
  dirName: string;              // 划出主题时即分配；合并且沿用被保留主题的目录
  status: TopicStatus;
  selected: boolean;            // 主题页勾选框
  keyPoints: string[];
  clips: TopicClip[];
  startedAt: string | null;     // 本主题开始生成的 ISO 时间
  elapsedSeconds: number | null;
  error: string | null;
};

export type VideoData = {
  version: 1;
  video: Video;                 // id/title/sourcePath/durationSeconds/outputDir
  transcript: Transcript;       // 原始转写（未应用纠错词表）+ speakers
  chunks: Chunk[];              // 分析分块；仅主题重跑要复用它，不能依赖可清除的缓存
  topics: TopicRecord[];
  importedAt: string | null;    // 首次生成的 ISO 时间；卡片「导入时间」
  sourceBytes: number | null;   // 源文件字节数；卡片文件大小
  asrModel: string | null;      // 这次转写用的 ASR 模型；字幕页照实显示
  updatedAt: string;
};

// TopicClip = { file, start, end, segmentIndexes }：切片实际覆盖的段下标，
// planClips 会把前移后重叠的段合成一个切片，所以一个切片可以覆盖多个段。
```

规则：

- 写盘一律 `writeJsonAtomic`。读不到文档时按旧目录迁移：标题取 `topic.md` 的 `# `，**时间段取 `topic.md` 的 `### [HH:MM:SS - HH:MM:SS]` 标题**（切片名带 3 秒前移且重叠会合一，反推不出原始边界），切片取目录里的文件名，要点取 `## 要点`，字幕为空；标题缺失时才用切片范围近似并给主题写 `error = "时间段按切片近似恢复"`。迁移结果不回写，等下一次生成或编辑再落盘。
- 字幕存**原始**转写；纠错词表在渲染 `topic.md`、生成主题/笔记、给界面出字幕时应用，不在文档里二次替换。界面用 `UtteranceInfo.index` 指向原始下标删除。
- 状态归一：读文档时若某主题是 `generating` 而该视频没有存活的运行锁，记为 `failed`，`error = "上次生成已中断"`。
- 库卡片状态：**有主题**、所有**已勾选**主题 `done` 且字幕非空 → `done`（空 `topics` 不算完成：`[].every` 会把「转写完、分段没落盘」误报成已完成）；有 `needs-rerun` 或 `failed` → `needs-rerun`；没有文档但有旧主题目录 → `needs-rerun`（旧目录缺结构化字幕）；没有文档也没有主题 → `in-progress`；其余 → `in-progress`。未勾选的主题不把视频拖成「未完成」。该视频有排队/运行中的任务时，`listLibrary` 收到 `busyVideoId` 把 `done` 压成 `in-progress`，卡片在任务期间不显示「已完成」。
- 运行锁：`<outputDir>/.vnote-run.lock`，`wx` 独占创建，陈旧锁用 `rename` 抢占，内容带 token，释放只删自己的锁。读状态兼容旧的 `<outputDir>/.cache/run.lock`。锁存在时结构编辑被拒绝；本进程持锁时允许写进度。
- 结构编辑（删段、合并）要求文档已有字幕；迁移来的旧文档直接拒绝，避免用空字幕把 `topic.md` 正文重写成空。
- 生成与编辑互斥：运行锁存在时所有编辑命令报「视频正在生成，完成后再编辑」。

### 7. core API 增补

core 仍是唯一业务逻辑所在。新增模块与函数（全部从 `@video-notes/core/storage` 或 `@video-notes/core` 导出）：

| 能力 | 现状 | 新增 |
|---|---|---|
| 文档读写 | 无 | `readVideoData(outputDir)`、`writeVideoData(outputDir, data)`、`emptyVideoData(video)`、`migrateVideoData(outputDir, video)` |
| 说话人改名 | 无 | `renameSpeaker(outputDir, speakerId, name)` |
| 删除单条字幕 | 无 | `deleteUtterance(outputDir, index)`（返回新文档并重写受影响 `topic.md`） |
| 删除整段 | 无 | `deleteTopicSegment(outputDir, topicId, segmentIndex)`（至少保留一段；只改文档并标记 `needs-rerun`，不删切片文件；有字幕时重写该主题 `topic.md`） |
| 合并主题 | 只有流水线内部合并 | `mergeTopics(outputDir, topicIds)`（≥2 个；`segments` 并集，`next.start < prev.end + 0.5` 时合并；标题用 ` / ` 连接；保留第一个主题的 id 与目录；**不删任何目录或文件**（ADR-0011 的保护规则照旧），被并掉的主题目录变成无引用，交给下一次生成的旧输出清理回收；摘要改为「合并后的主题，摘要需要重新生成」；标记 `needs-rerun`） |
| 运行锁 | `.cache/run.lock`，接管时会无条件删锁（双进程可同时成功） | `<outputDir>/.vnote-run.lock`，`wx` 独占创建 + `rename` 接管陈旧锁 + 持有者 token 释放；读状态同时兼容旧路径；缓存清理不碰它 |
| 编辑与生成互斥 | 无 | 结构编辑在锁（任何存活持有者）存在时报「视频正在生成，完成后再编辑」；生成进程自己的进度写入放行 |
| 主题勾选 | 无 | `setTopicSelected(outputDir, topicId, selected)` |
| 主题进度与耗时 | 只有任务级进度 | `setTopicProgress(outputDir, topicId, patch)`；生成时 `status=generating` + `startedAt`，结束 `status=done` + `elapsedSeconds` |
| 段落级数据 | 只有切片文件名 | `video.json` 的 `segments` + `clips`；`readLibraryVideo` 直接返回 |
| 设置（notes/缓存/模型目录） | 只读 env | `core/settings.ts`：`defaultSettings(env)`、`loadSettings(configPath, env)`、`saveSettings(configPath, patch, env)`；优先级 env > settings.json > 默认；只存三个路径，不存 key |
| 全局术语表保存 | 只有视频级 | `saveGlobalCorrections(root, entries)` |
| 术语表来源/时间 | 无 | 词条可选字段 `source?: "manual" \| "from-subtitle"`、`updatedAt?: string`；旧文件缺字段时显示「手工」与文件 mtime |
| 缓存占用与清理 | 无 | `cacheUsage(cacheRoot)`、`clearCache(cacheRoot, videoDirs)` |
| 仅笔记生成 | 无 | `pipeline/notes-run.ts`：`runNotes({ outputDir, topicIds, endpoint, cacheDir, client, onProgress })`；`topicIds` 必须非空；沿用文档里的 `dirName`，局部生成后从完整文档重建 `index.md` |
| 仅主题+笔记重跑 | 无 | `runTopics({ outputDir, endpoint, cacheDir, client, onProgress })`（用已存字幕重新划主题，再生成笔记） |
| 全量重跑 | `runExtract` | 增加 `cacheRoot` 输入；落 `video.json`；按主题写状态与耗时 |

缓存目录从「每个输出目录下的 `.cache`」改为 `<cacheRoot>/<videoId>/`，让设置页的「缓存目录 / 清理缓存」管到所有视频。缓存是按内容哈希的可丢产物，旧 `<outputDir>/.cache` 不迁移，清理缓存时一并删除。

### 8. IPC 契约

`apps/desktop/src/shared/ipc.ts` 重写，renderer 只认 DTO。新增/变更通道：

| 通道 | 参数 | 返回 | 谁干活 |
|---|---|---|---|
| `library:list` | — | `LibraryVideo[]`（加 `status`、`needsRerun`） | core |
| `video:detail` | `videoId` | `VideoDetail`（加 `transcript`、`topics[].segments/status/keyPoints/clips/startedAt/elapsedSeconds`、`video.mediaUrl`、`asrModel`、`video.importedAt/sizeBytes`） | core + main 编码 media URL |
| `video:rename-speaker` | `videoId, speakerId, name` | `VideoDetail` | core |
| `video:delete-utterance` | `videoId, index` | `VideoDetail` | core |
| `video:delete-segment` | `videoId, topicId, segmentIndex` | `VideoDetail` | core |
| `video:merge-topics` | `videoId, topicIds[]` | `VideoDetail` | core |
| `video:set-topic-selected` | `videoId, topicId, selected` | `VideoDetail` | core |
| `video:save-corrections` | `videoId, entries` | `CorrectionEntry[]` | core |
| `glossary:save` | `entries` | `CorrectionEntry[]` | core |
| `notes:start` | `videoId, topicIds[]` | `{ jobId }` | core `runNotes`（worker） |
| `topics:rebuild` | `videoId` | `{ jobId }` | core `runTopics`（worker） |
| `extract:start` | `ExtractTarget` | `{ jobId }` | core `runExtract`（worker） |
| `settings:status` | — | `SettingsStatus`（三个路径 + 缓存占用 + ffmpeg + LLM 配置状态） | main + core |
| `settings:update` | `{ notesRoot?, cacheRoot?, modelDir? }` | `SettingsStatus` | core `saveSettings` |
| `settings:pick-dir` | `"notes" \| "cache" \| "model"` | `string \| null` | main dialog |
| `settings:clear-cache` | — | `{ freedBytes }` | core |
| `settings:test-llm` | — | `{ ok, model, message }` | main（一次 `GET /models`） |
| `glossary:list` | — | `CorrectionEntry[]` | core `readGlobalCorrections` |
| `shell:reveal` | `outputDir` | — | main（含 notes 根目录校验） |

`JobSnapshot` 增加 `kind: "extract" \| "notes" \| "topics"`，让界面知道刷新什么；`extract:event` 通道名保留。运行中的快照再加 `topicId` 与 `topicPercent`（0–100，按该主题已切出的切片比例前进；LLM 阶段是 0，只有切片阶段会动），界面按 `topicId` 关联主题，不用标题匹配。`JobQueue.active()` 优先返回运行中的任务，排队快照不覆盖它；任务入队时冻结当时的 notes/cache/model 三个目录。`SettingsStatus` 增加 `ffmpegVersion` 与 `locked`（被 `VNOTE_HOME`/`VNOTE_CACHE_DIR`/`VNOTE_MODEL_DIR` 覆盖的字段在设置页只读）。

### 8.1 与原型不一致的显式取舍

原型里还有这些元素，本轮**不做**，因为它们需要新的产品决定或外部资源，且 brief 的验收清单没有要求：

- 语音转写的「提供方」下拉与远端 ASR：桌面端固定本地 sherpa-onnx（`AsrStatus.provider` 是字面量），不提供远端切换。
- 「下载模型」「导入本地模型」按钮：模型仍放在模型目录里由用户自行放入；设置页只显示模型目录、模型 id、是否已存在。
- 总结分析的接口地址 / 模型名 / API key 可编辑：仍按 ADR-0009 由 env/.env 提供，设置页只显示状态与「测试连接」。
- 卡片的分辨率（`886×1920`）：没有记录该字段，卡片只显示导入时间与文件大小。
- 「视频预览」的播放控件（开发者调试用的原型假播放器）：真实实现是原生 `<video>`，播放/暂停/进度由浏览器控件提供。

前四项已由 [ADR-0015](./0015-prototype-deferred-features.md) 补齐（远程 ASR 为 OpenAI 兼容转录接口，提供方文案与本节原始设想不同，理由见 ADR-0015 §5、§10）；最后一项仍然成立。

### 9. 删除清单（先减后加）

删除：`components/SettingsPanel.tsx`、`components/NoteView.tsx`、`components/CorrectionsEditor.tsx`、`rbp/blocks/bento-29.tsx`、`rbp/react-bits/luminous-type.tsx`、`app-shell-6` 里的 `TopicTree`/`NoteView`/原生播放器三栏旧实现、`app-shell-1` 的统计块与导入按钮、旧 `data-table-3` 的演示表头/保存栏逻辑（保留行原语）。`reactbits.json` 去掉 `bento-29` 与 `luminous-type-tw`。renderer 不再依赖 `react-markdown`/`remark-gfm`（笔记页只渲染要点列表与切片），从 `apps/desktop/package.json` 移除。

### 10. 验证

- `bun run typecheck`、`bun run test`、`bun run build` 全绿；core 新逻辑有行为测试（文档往返、迁移、合并并集、删除至少保留一段、设置优先级、进度落盘、笔记生成状态、锁抢占）。
- 真实启动 Electron（`VNOTE_HOME` 指向 tmp 夹具目录），逐页截图到 `tmp/artifacts/r22-ui-redo/`，与原型截图同名对照。夹具来自一次真实 `vnote extract --limit 420` 的产物，另加一份产物副本（第二张卡片）与三条术语表词条；生成中截图来自真实的 `notes:start` 任务。
- 一份检查清单：本 ADR 第 1 节 30 条 + 第 7 节能力 → 证据（截图、测试名、代码位置）。

## Considered Options

- **继续用 `topic.md` 当唯一事实来源，界面解析 markdown**：字幕页需要逐条字幕与说话人，markdown 里只有按段合并的对话；删除字幕/整段、合并主题都要改 markdown 再反解析，解析错误会静默丢数据。不采用。
- **把字幕存进 SQLite**：桌面端只读 notes 目录，SQLite 会让「笔记目录可被人直接看」和备份/同步变复杂，还引入原生依赖。JSON 文档 + 原子写已足够。不采用。
- **在 renderer 里放业务逻辑（合并、删除、重排切片）**：违反 ADR-0012「界面只调 core」，CLI 与桌面端会出现两套规则。不采用。
- **把 LLM key 也放进 settings.json**：key 会落到磁盘上的明文配置；ADR-0009 已定 env/.env 单一来源。设置页对 LLM 只显示状态与「测试连接」。不采用。
- **为原型新增 RBP 条目（dialog/tabs/toast）**：需要联网 + license，且 `rbp/` 重跑会覆盖本地改造。用现有条目 + 少量手写结构；ADR-0013 的「源码可改」已允许。不采用。
- **保留旧三栏详情页并「顺手」加新页面**：两套导航、两套状态、两套视觉，用户会看到互相矛盾的界面。按 brief 逐页重做并删旧结构。不采用。
- **把说话人编号（S1/S2）留在字幕行**：违反 v4 #7。字幕行只显示颜色 + 姓名。不采用。

## 后果

- `video.json` 成为新增的磁盘契约；旧输出目录要迁移读取，且迁移不出字幕（只有在旧目录重跑后才有字幕页）。
- 删除段落或合并主题后主题进入 `needs-rerun`，旧切片可能不完整；只有完整覆盖该段的切片才算可用（`clip.start <= seg.start` 且 `clip.end >= seg.end - 0.4`），否则界面显示「片段待重新生成」，用户点「单独重新生成」补回。合并与删段都不删文件；被并掉的主题目录由下一次生成的旧输出清理按 ADR-0011 回收。
- `topic.md`/`index.md` 是派生产物：有字幕的视频做结构编辑时会重写它们，外部编辑会被覆盖；没有字幕的迁移文档直接拒绝结构编辑，正文不会被空字幕抹掉。职责写进 GLOSSARY。
- 缓存改到 `<cacheRoot>/<videoId>/` 后，第一次运行会重新算缓存（可丢弃，不影响正确性）。
- 设置存到 Electron `userData/settings.json`；换 notes 根目录等于换一个库，旧库留在原路径，不做搬迁。
- `react-markdown` 移除后，笔记页只显示要点与切片；完整 markdown 仍在输出目录里，可用系统默认应用打开。
- 视频 id 由源文件路径哈希决定（ADR-0002）：源文件被移动或改名后，重跑时 `pickSource` 会拒绝不匹配的文件，只能当新视频重新导入，旧输出目录与库条目脱钩。
