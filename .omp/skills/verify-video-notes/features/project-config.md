# 项目配置 tab：监控目录、分块时长、目录视频表（#128）

「整理切片 / <项目> / 项目配置」是项目页的默认 tab：输入录屏输出目录后「开始监控」，监控状态从「尚未监控」变成「监控中」；下面是目录里的视频表，按修改时间倒序，带表头全选、逐行勾选、「开始整理」和工作状态三态（未整理 / 持续整理中 / 整理已结束），没有「录制状态」列。表里只显示主进程的快照：项目详情（`getProject`）新增 `directory` 数组，界面不直接读文件系统（ADR-0012）。

## Sub-features

- `project-monitor-directory`: 目录输入 + 开始监控 + 填入示例（`<项目目录>/recordings`）。开始监控前主进程校验目录存在且是文件夹，拼错路径当场报错、状态仍是「尚未监控」；一旦监控，输入框与两个按钮都锁定。
- `project-directory-table`: 目录快照（只扫一层、只收白名单扩展名）按修改时间倒序；大小取文件系统，时长取视频库已知值，未导入显示 `—`。计数 `N 个文件`。
- `project-selection`: 表头全选（0 个文件时 disabled，部分选中 indeterminate）、逐行勾选、`已选 N 个 · 已加入 M 个`、「开始整理 (N)」/「加入整理」/无新勾选时 disabled。取消勾选只改勾选，不撤已加入的任务。
- `project-three-states`: 未整理 / 持续整理中 / 整理已结束（严格超过 30 秒不动且全部分块切片完成），外加「已处理 HH:MM:SS」小字。
- `project-chunk-minutes`: 分块时长输入，1–30 夹值并四舍五入，空/非数字回落 10；修改落盘到项目记录。

## How to get to it (user POV)

左侧「整理切片」→ 项目列表填名称与项目目录 → 创建后直接进入项目页，默认就是「项目配置」tab。新建项目时目录输入留空 → 空态：`尚未监控`、`0 个文件`、全选与开始整理都不可点。点「填入示例」拿到 `<项目目录>/recordings`，建好这个目录后点「开始监控」，表格立刻出现该目录里的视频（新文件默认不勾选）。勾选后点「开始整理」，行内状态先变「持续整理中」，分析 + 切片跑完变「整理已结束」并显示已处理时长，产物在 `<项目目录>/clips/`。

## Driving it with verify.ts

```bash
V="bun .omp/skills/verify-video-notes/scripts/verify.ts drive"

# 建项目（默认落在项目配置 tab）
$V click '[data-testid=nav-slicer]'
$V fill '[data-testid=project-create-name]' 'r84 配置验收'
$V fill '[data-testid=project-create-root]' '/abs/path/切片项目'      # 先 mkdir，目录要存在
$V click '[data-testid=project-create]'
$V wait "document.querySelector('.vn-config') !== null"

# 空态：尚未监控、0 个文件、两个按钮 disabled
$V eval "({ monitor: document.querySelector('[data-testid=project-monitor-status]').textContent, count: document.querySelector('[data-testid=project-file-count]').textContent, all: document.querySelector('[data-testid=project-select-all]').disabled, start: document.querySelector('[data-testid=project-organize-start]').disabled })"

# 填入示例 → <项目目录>/recordings
$V click '[data-testid=project-monitor-example]'
$V eval "document.querySelector('[data-testid=project-monitor-directory]').value"

# 夹值：0→1、99→30、4.6→5（Enter 触发 commit，值会被写回输入框）
$V fill '[data-testid=project-chunk-minutes]' '0'
$V press Enter
$V wait "document.querySelector('[data-testid=project-chunk-minutes]').value === '1'"

# 开始监控：无效目录 → toast，状态不变；示例目录 → 监控中，表格出现行
$V fill '[data-testid=project-monitor-directory]' '/tmp/不存在'
$V click '[data-testid=project-monitor-start]'
$V wait "document.querySelector('[data-testid=toast-host]')?.textContent?.includes('开始监控失败')"
$V click '[data-testid=project-monitor-example]'
$V click '[data-testid=project-monitor-start]'
$V wait "document.querySelectorAll('[data-testid=project-file-checkbox]').length > 0"

# 全选三态 / 选择提示 / 开始整理文案
$V click '[data-testid=project-select-all]'
$V eval "({ checked: document.querySelector('[data-testid=project-select-all]').checked, selection: document.querySelector('[data-testid=project-selection-info]').textContent, start: document.querySelector('[data-testid=project-organize-start]').textContent })"
$V click '[data-testid=project-file-checkbox]' --index 1
$V eval "document.querySelector('[data-testid=project-select-all]').indeterminate"

# 开始整理 → 三态，取消勾选不撤任务
$V click '[data-testid=project-organize-start]'
$V wait "Array.from(document.querySelectorAll('[data-testid=project-file-status]')).some(e => e.textContent === '持续整理中')"
$V click '[data-testid=project-file-checkbox]' --index 1
$V wait "Array.from(document.querySelectorAll('[data-testid=project-file-status]')).some(e => e.textContent === '整理已结束')" --timeout 240000
```

表格行的稳定句柄：`project-file-checkbox`（`--index` 按当前排序）、`project-file-name`、`project-file-status`（`data-status=unorganized|organizing|finished`）、`.vn-config-processed`（已处理小字）、`.vn-config-file-meta`（大小 / 时长）、`.vn-config-empty`（空态文案）。

## Gotchas

- 这个 tab **没有目录轮询**（#132 第二阶段）：监控中的新文件、增长的修改时间只在下一次项目事件推送（修改分块、开始整理、任务进度）时进表。验收「新文件默认不勾选」时，先往目录里放一个文件，再改一次分块时长让快照刷新。
- 开始监听的校验在主进程（`checkDirectory`），不在界面：目录被删后再点开始监控会得到 toast，`monitoring` 仍是 false，项目记录不落盘。
- 分块时长与原型 `configure()` 有一处有意差异：空值 / 非数字回落 10 分钟（原型是 `Number('')===0` 夹到 1）。
- 开始整理只把「勾选且未加入」的 id 送出去；界面全量刷新走 `projects:event`，不要用 invoke 返回值覆盖 `project`——开始整理要跑导入 / ffprobe，响应可能晚于事件推送。
- 「已加入」的真相源是项目记录的 `videoIds`：重启后控制器还没 `startOrganize`，状态按「持续整理中」显示，不会退回「未整理」。
