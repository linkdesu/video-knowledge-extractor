# Diarization Lab（开发模式验收台，r48）

开发模式下（`app.isPackaged === false`）多出一个「🧪 Lab」页面：把音视频样本或一个已有实验目录拖进来，页面同时渲染 A/B 两套说话人方案的色带、差异清单与完整字幕行，点任意一行或色带即可试听该段；语气词阈值滑块只重算过滤（不重新聚类）；差异行可以打「B 对 / A 对 / 都错」标记并持久化。打包版既没有入口、也没有 IPC、也没有 `vnote-media://lab/` 音频协议。

## Sub-features

- 入口与门禁：左侧导航底部 `nav-lab`（灰色），只在开发模式出现；打包版导航、路由、详情页按钮都不存在。
- 样本导入：整页接收拖拽。音视频文件走「抽 16k wav → sherpa 分离 → CAM++ 逐段嵌入 → 段级 ASR」，样本落缓存根 `<cacheRoot>/<键>/`（r54 起默认 `~/.cache/video-notes/lab-cache`，所有 worktree 共用）；含 `segtext-*.json` 的实验目录零计算直接加载。同一份内容 + 同一套参数的二次拖入命中缓存（r53，见下）。
- 分析缓存（r53）：键 = schema + 源内容哈希（文件流式 sha256 / 目录逐个文件哈希）+ 规范化分析参数（五个模型文件的名字与大小/mtime、`segmentPaddingSeconds`、`embedMinSeconds`、`DIARIZATION_TUNING`、`SILENCE_DETECTION`、二次聚类 `seedSeconds`/`maxK`/`fallbackCut`、`speakerCount`）。键即样本 id，条目即样本目录；`sample.json` 的 `analysis` 字段记键/schema/源指纹/参数。命中只读 JSON，不 fork worker、不加载模型、不解码；`sample.json` 必填字段、`segments/segtext/silences/embeddings` 的行数与每行形状、`audio.wav` 的 RIFF/WAVE 头、登记的 `labelsFile`/`anchorsFile` 形状任一不对都按 miss 重算。落盘走 `<cacheRoot>/.tmp/<键>-XXXXXX` 整目录 rename，失败/取消删临时目录，启动清一天前的残留（`docs/adr/0034-lab-analysis-cache.md`）。
- 缓存模式与位置（r54）：`--lab-cache=shared|isolated|cold`（或环境变量 `VNOTE_LAB_CACHE`；命令行优先）。`shared`（`bun run dev` 默认）读写 `~/.cache/video-notes/lab-cache`（`VNOTE_LAB_CACHE_DIR` 可覆盖，`$XDG_CACHE_HOME` 优先于 `~/.cache`）；`isolated` 每次启动 `mkdtemp` 一个空临时目录，只读写它、完全不碰共享目录；`cold` 用共享目录但跳过命中判定，算完整目录覆盖写回。拼错或缺值直接启动失败，不静默回退。`verify.ts up` 默认 `--lab-cache=isolated`，`state.json#labCache` 记录本次模式（`docs/adr/0035-lab-cache-shared-and-worker-lifecycle.md`）。
- 并发与迁移（r54）：两个 worktree 同时发布同一个键时，`rename` 撞 `ENOTEMPTY`/`EPERM` 会把当前目标挪进 `.tmp` 重试（≤4 次）；重试用尽且对方已留下完整 `sample.json` 就接受对方那份。发布前 `fsync` 整棵临时目录、发布后 `fsync` 父目录。首次以 shared/cold 启动时把旧分支目录（`<worktree>/tmp/verify/lab`）里共享目录缺失的条目 + `marks-<id>.json` 复制过去，只复制不删旧目录，幂等。
- worker 生命周期（r54）：一次未命中 = 一个 `lab-worker.js` 进程。worker 回 `done`/`error` 后等主进程 `{type:"ack"}` 再 `process.exit(0)`；主进程 ack 后起 2s 宽限兜底 `kill`，`exit` 时记 `Lab worker 退出`（`key`/`code`/`live`），app 退出时 `dispose()` 无条件杀光。连续 5 次未命中后进程数必须回到 0（r48–r53 每次未命中留一个常驻进程）。
- 缓存上限淘汰（r55）：条数 / 总字节 / 存活时间三道上限，默认 **200 条 / 20 GiB / 30 天**；`VNOTE_LAB_CACHE_MAX_ENTRIES`、`VNOTE_LAB_CACHE_MAX_BYTES`、`VNOTE_LAB_CACHE_MAX_AGE_DAYS` 覆盖（非负整数，`0` = 不限制，非法取值启动即抛错）。`shared`/`cold` 启动时与每次发布后各跑一次：先按 `sample.json#createdAt` 淘汰超龄条目（缺失退回目录 mtime），再按最旧优先淘汰超量/超字节的条目；刚发布的键先占额度、永不淘汰；`.tmp`、`marks-*.json` 不参与。日志 `Lab 缓存：按上限淘汰旧条目`（`removed`/`reasons`/`kept`/`keptBytes`/`failed`），启动行 `Lab 缓存就绪` 带 `limits`（`docs/adr/0036-lab-cache-eviction-dedupe-and-force-rerun.md`）。
- 同内容去重（r55）：发布成功后删掉 `analysis.sourceHash` 相同、键不同的旧条目（模型 mtime / schema 变了留下的重复），日志 `Lab 缓存：同内容旧条目已删除`；样本列表 `listSamples` 再按内容指纹去重、保留最新一条，所以历史重复也不会在「最近样本」里出现两次。没有 `analysis` 戳的 r53 之前条目既不删也不合并。命中路径不做去重（不删别的 worktree 正在读的目录）。
- 命中可见与强制重算（r55）：`lab.importPath(path, { force })` 返回 `{ sampleId, hit, reason, hashMs, elapsedMs, sourceHash }`。顶栏状态行 `lab-cache-status`：命中 → `命中缓存 · 12 ms · 未加载模型、未解码音频`（青色）；未命中 → `重新分析 · 3.6 s` / `强制重新生成 · 2.9 s` / `cold 模式重算 · …`（muted，`reason` 在 `title`）。`lab-force`「强制重新生成」按钮对当前样本按 `{ force: true }` 重算并覆盖（无样本或导入中禁用，失败保留旧条目），日志 `reason="forced"`、`forced=true`。
- 样本切换：顶栏「最近样本」下拉。
- 方案：A/B 各自可选 `baseline`（sherpa 原始簇）/ `refine`（二次聚类）/ `refine + filter`（整行语气词隐藏）；摘要显示双方说话人数、主播锚点簇数、过滤行数与秒数、两方案不同的行数。
- 对比时间轴：上下两条色带，每色一个说话人；过滤行灰斜纹；两方案说话人不同的区间在两带之间标红；播放头联动，点色带播放该段。
- 字幕行：完整列表（时间 / A 说话人 / B 说话人 / 文本 / 状态）；点行定位、高亮、从行首播放；时间轴点击反向定位；跳转框接受 `13:14` 或行号；`Cmd/Ctrl+F` 聚焦搜索；筛选 全部 / 仅差异 / 仅已过滤 / 仅某说话人。
- 试听：`J`/`K` 上一个/下一个差异并自动播放，空格播放/暂停，`1`/`2` 听同一行在 A/B 方案下的说话人样例；说话人面板 `▶样例` 依次播放该簇最长的三段。
- 阈值滑块：0.6–1.5s，纯客户端重算，不触发 IPC、不重新聚类。
- 标记：差异行打「B 对 / A 对 / 都错」，写 `<cacheRoot>/marks-<样本>.json`（r54 起默认共享缓存根），重开仍在。
- 输入区布局（r52）：`.vn-lab-bar-row` 是一个 4 列网格，拖放提示 `lab-dropzone` 独占首行，最近样本 / 方案 A / 方案 B / 阈值四列等宽（16px gap、底边对齐）；视口 ≤1053px 降成 2×2，≤760px 单列。Select 触发器 `box-sizing: border-box` + `min-width: 0`，长样本名用省略号截断，展开的下拉不越出卡片内容宽。
- 视图状态保留（r52）：样本、方案 A/B、阈值、页面滚动（`.vn-content`）与字幕行列表滚动写进 `localStorage['vn.lab.view']`（`renderer/src/lib/lab-view-state.ts`，严格白名单 + clamp），导航离开再返回、以及整机重启后都还原来同一屏。
- 下拉弹层（r52c）：`Select` 的 `role=listbox` 通过 `createPortal` 渲染到 `document.body`，`.vn-select-list.portal` 用 `position: fixed` + 内联锚点几何（`z-index: 55`），打开期间跟随内容区滚动/窗口缩放。留在卡片里会被 `.vn-card` 的 `backdrop-filter` 层叠上下文困住，卡片比弹层矮时下方卡片会盖住第 2 个及以后的选项（r52b 的 G1）。验收要按**命中**判：对每个选项取 `getBoundingClientRect()` 中心做 `elementFromPoint`，断言落点 `closest('[role=option]')` 就是该选项，再用真实鼠标点击并断言触发器文案变成该选项；1280/900/700/520 四档都要测（r52c 证据 `tmp/verify/r52c-hit/hit-*.json`）。

## How to get to it (user POV)

1. 在仓库里跑 `bun dev`（`apps/desktop`），左侧导航底部出现 `🧪 Lab`。
2. 点它进入验收台；没有样本时页面提示把音视频或实验目录拖进来。
3. 拖入 `/Users/link/Documents/video-notes/` 下的语音样本（`.ts`/`.mp4`/`.mp3`/`.wav`），或拖入一个含 `segtext-*.json` + `labels-*-T1.0.json` 的实验目录。
4. 选方案 A/B，听差异行；拖阈值滑块看过滤行数变化；打标记。

## Driving it with verify.ts

```bash
V="bun .omp/skills/verify-video-notes/scripts/verify.ts drive"
bun .omp/skills/verify-video-notes/scripts/verify.ts up --run r54-lab-dev --lab-cache=isolated

$V click '[data-testid=nav-lab]'
$V status
# Lab 的拖放区是独立的 lab-dropzone（不与视频库导入的 dropzone 共用），drop 必须显式给选择器
$V drop '/Users/link/Documents/video-notes/<样本>.ts' --selector '[data-testid=lab-dropzone]'   # 真实导入，耗时 5 分钟左右
$V wait "window.vnote.lab.list().then(x => x.length >= 2)" --timeout 600000
$V click '[data-testid=lab-sample-select]'                # 真下拉（role=combobox + listbox），见下
$V click '[data-testid=lab-line-3]'
$V eval "document.querySelector('[data-testid=lab-audio]').currentTime"   # 行首附近
$V text '[data-testid=lab-cache-status]'                  # r55：命中缓存 · 12 ms · 未加载模型、未解码音频 / 重新分析 · 3.6 s
$V click '[data-testid=lab-force]'                        # r55：跳过缓存重算并覆盖（真跑模型）
$V wait "document.querySelector('[data-testid=lab-cache-status]')?.textContent?.includes('强制重新生成')" --timeout 600000
$V shot r48-lab-dev
$V snapshot r54-lab-dev
```

- `lab-progress` 显示导入阶段（抽音频 / 分离 / 嵌入 / 段级解码）；导入期间不要另开 Lab 导入，也不要同时跑生成任务（本机模型严格串行，主进程会拒绝）。
- 阈值验证：`$V eval "performance.now()"` 前后各读一次过滤行数，或直接断言 `lab-summary` 文本在两个阈值下不同。
- 标记持久化：打完 `lab-mark-B` 后 `down` + 新 run id 复用同一 `--home` 与旧 run 的 userData（`--user-data tmp/verify-state/<旧 run>/user-data`，r50 起 userData 不在证据目录里），重开页面断言按钮仍高亮。
- 视图状态保留（r52）：改样本/A/B/阈值并真实滚轮滚动后，`$V click '[data-testid=nav-library]'` → `nav-lab`，断言四值与两处 `scrollTop` 复原；再 `down` + 新 run id 复用同一 userData，重开后同样断言。`localStorage['vn.lab.view']` 是唯一真相源，`down` 只在 `user-data/Local Storage` 为空时才剪掉它。
- 打包版证明：`verify.ts up --app "/Applications/Video Notes.app" --no-build`，断言 `nav-lab` 不存在、`window.vnote.lab === undefined`、`vnote-media://lab/<id>` 的 fetch 直接失败（协议 handler 未注册，返回 ERR_FAILED 而不是 404）。

## Gotchas

- **Lab 的音频协议只读 `audio.wav`**：`vnote-media://lab/<id>` 固定映射 `<cacheRoot>/<id>/audio.wav`，样本没有音频时页面禁用播放。
- **实验目录必须带 `segtext-*.json`**：只有 `labels-*.json` 的目录会被拒绝（缺段级文本无法判语气词）。
- **`refine` 与语气词规则只存在于 Lab**：`apps/desktop/src/main/dev-lab/` 与 `shared/lab-*.ts`，不进入 `packages/core` 正式管线；不要在视频页断言同样的聚类数。
- **打包版首帧可能超过 20s**：`up --app` 的就绪等待写死 20s，实测安装包首次启动约 16s、冷启更久；超时后可用 CDP 直连同一个安装包补证据（r48 实测 `nav-lab=false`、`vnote.lab=undefined`）。
- **`refine` 是自适应 k**：`cut 0.65` 只是种子 < 8 时的回退值；30 分钟样本上是 BIC + silhouette 选出 7 簇，不能拿固定切点解释。
- **主播簇数依赖样本自带锚点**：只有实验目录里带 `gt-anchors*.json` 时摘要才显示 `主播簇 A→B`，否则是 `—`。
- **播放不用 media fragment**：自定义 scheme 上 `<audio src="…#t=start,end">` 实测 error 4，改为 seek 到行首 + `timeupdate` 自动停。
- **样本目录在用户级缓存根**：默认 `~/.cache/video-notes/lab-cache/`（`VNOTE_LAB_CACHE_DIR` 可覆盖），不进笔记库、不受 `VNOTE_HOME` 隔离、被所有 worktree 共享；跟踪 `verify.ts drive log` 里启动行的 `Lab 缓存就绪 mode=… root=…` 确认这一跑用的是哪个目录。isolated 的目录在系统 tmp 下（`vnote-lab-isolated-*`），`down` 不会删它。
- **QA 默认 isolated**：`up` 不带 `--lab-cache` 就是 `isolated`，因此同一个样本在 QA 里必然第一次全量跑；想验证共享命中要显式 `--lab-cache=shared`（会读/写 `~/.cache`，别用它跑断言「首次」的用例）。`state.json#labCache` 是唯一可审计来源。
- **worker 进程数必须回到 0**：一次未命中 = 一个 `lab-worker.js`。导入结束后 `pgrep -fl lab-worker.js`（或 `ps -o pid,command -ax | grep lab-worker`）应为空；日志里每次任务有 `Lab worker 启动` 与 `Lab worker 退出 code=0`。连续 5 次未命中仍不增长才算过（r54 修复 r48 起的进程泄漏）；app 退出后仍残留说明 `before-quit → dispose()` 被绕过。
- **缓存命中看键路径上的条目，不看 `.tmp`**：`.tmp/<键>-<pid>-<时间>` 是 worker 的落盘目录，rename 到位才算条目；`.tmp` 下超过一天的东西启动时会被回收（r53）。
- **重复导入同一份内容不会多一条样本**：键相同即同一条目；r53 之前按路径指纹建的旧目录仍在，同一个源会同时出现旧条目与新条目。r55 起发布成功后还会删掉 `analysis.sourceHash` 相同、键不同的旧条目，列表也按内容指纹去重（保留最新一条）。
- **证明命中不用猜**：`verify.ts drive log 40` 里找 `Lab 分析缓存命中：未加载模型、未解码音频 … cacheMode=shared|isolated|… root=… elapsedMs=<小>`（r55 起文案直说，另有 `modelLoads=0 decodedSegments=0`），未命中是 `Lab 分析缓存未命中 … reason="missing"`，cold 模式恒为 `reason="cold"`，按「强制重新生成」是 `reason="forced" forced=true`；三者都带 `key` 与 `hashMs`。
- **跨 worktree 共享的验收姿势**：worktree A 用 `--lab-cache=shared`（或默认）跑完一个样本，worktree B 用同一 `--lab-cache=shared` 拖同一份文件，B 的日志必须是 `Lab 分析缓存命中：未加载模型、未解码音频` 且 `elapsedMs` 在毫秒级、没有 `Lab worker 启动`。两个 worktree 同时拖同一份文件也不能出现半截条目：`sample.json` 必须可解析、`audio.wav` 必须是 RIFF/WAVE。
- **界面上的命中/耗时看 `lab-cache-status`**：`$V text '[data-testid=lab-cache-status]'` 读文案（命中带「未加载模型、未解码音频」），`$V click '[data-testid=lab-force]'` 触发强制重算，再用 `$V wait "…textContent?.includes('强制重新生成')"` 等它结束；重算期间按钮为 `disabled`。
- **淘汰要测就换一个缓存根**：`VNOTE_LAB_CACHE_DIR=<临时目录> VNOTE_LAB_CACHE_MAX_ENTRIES=1 $V up --lab-cache=shared`，启动行 `Lab 缓存就绪 … limits={…}` 与随后的 `Lab 缓存：按上限淘汰旧条目 … reasons=["count"|"age"|"bytes"]` 是证据；别拿真实 `~/.cache` 跑上限测试。`verify up` 会继承环境变量，所以这两个变量放在命令前即可。
