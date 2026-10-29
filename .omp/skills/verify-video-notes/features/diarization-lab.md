# Diarization Lab（开发模式验收台，r48）

开发模式下（`app.isPackaged === false`）多出一个「🧪 Lab」页面：把音视频样本或一个已有实验目录拖进来，页面同时渲染 A/B 两套说话人方案的色带、差异清单与完整字幕行，点任意一行或色带即可试听该段；语气词阈值滑块只重算过滤（不重新聚类）；差异行可以打「B 对 / A 对 / 都错」标记并持久化。打包版既没有入口、也没有 IPC、也没有 `vnote-media://lab/` 音频协议。

## Sub-features

- 入口与门禁：左侧导航底部 `nav-lab`（灰色），只在开发模式出现；打包版导航、路由、详情页按钮都不存在。
- 样本导入：整页接收拖拽。音视频文件走「抽 16k wav → sherpa 分离 → CAM++ 逐段嵌入 → 段级 ASR」，样本落仓库 `tmp/verify/lab/<指纹>/`；含 `segtext-*.json` 的实验目录零计算直接加载。同一指纹二次拖入命中缓存。
- 样本切换：顶栏「最近样本」下拉。
- 方案：A/B 各自可选 `baseline`（sherpa 原始簇）/ `refine`（二次聚类）/ `refine + filter`（整行语气词隐藏）；摘要显示双方说话人数、主播锚点簇数、过滤行数与秒数、两方案不同的行数。
- 对比时间轴：上下两条色带，每色一个说话人；过滤行灰斜纹；两方案说话人不同的区间在两带之间标红；播放头联动，点色带播放该段。
- 字幕行：完整列表（时间 / A 说话人 / B 说话人 / 文本 / 状态）；点行定位、高亮、从行首播放；时间轴点击反向定位；跳转框接受 `13:14` 或行号；`Cmd/Ctrl+F` 聚焦搜索；筛选 全部 / 仅差异 / 仅已过滤 / 仅某说话人。
- 试听：`J`/`K` 上一个/下一个差异并自动播放，空格播放/暂停，`1`/`2` 听同一行在 A/B 方案下的说话人样例；说话人面板 `▶样例` 依次播放该簇最长的三段。
- 阈值滑块：0.6–1.5s，纯客户端重算，不触发 IPC、不重新聚类。
- 标记：差异行打「B 对 / A 对 / 都错」，写 `tmp/verify/lab/marks-<样本>.json`，重开仍在。

## How to get to it (user POV)

1. 在仓库里跑 `bun dev`（`apps/desktop`），左侧导航底部出现 `🧪 Lab`。
2. 点它进入验收台；没有样本时页面提示把音视频或实验目录拖进来。
3. 拖入 `/Users/link/Documents/video-notes/` 下的语音样本（`.ts`/`.mp4`/`.mp3`/`.wav`），或拖入一个含 `segtext-*.json` + `labels-*-T1.0.json` 的实验目录。
4. 选方案 A/B，听差异行；拖阈值滑块看过滤行数变化；打标记。

## Driving it with verify.ts

```bash
V="bun .omp/skills/verify-video-notes/scripts/verify.ts drive"
bun .omp/skills/verify-video-notes/scripts/verify.ts up --run r48-lab-dev

$V click '[data-testid=nav-lab]'
$V status
$V drop '/Users/link/Documents/video-notes/<样本>.ts'     # 真实导入，耗时 5 分钟左右
$V wait "window.vnote.lab.list().then(x => x.length >= 2)" --timeout 600000
$V click '[data-testid=lab-sample-select]'                # 真下拉（role=combobox + listbox），见下
$V click '[data-testid=lab-line-3]'
$V eval "document.querySelector('[data-testid=lab-audio]').currentTime"   # 行首附近
$V shot r48-lab-dev
$V snapshot r48-lab-dev
```

- `lab-progress` 显示导入阶段（抽音频 / 分离 / 嵌入 / 段级解码）；导入期间不要另开 Lab 导入，也不要同时跑生成任务（本机模型严格串行，主进程会拒绝）。
- 阈值验证：`$V eval "performance.now()"` 前后各读一次过滤行数，或直接断言 `lab-summary` 文本在两个阈值下不同。
- 标记持久化：打完 `lab-mark-B` 后 `down` + 新 run id 复用同一 `--home`/`--user-data`，重开页面断言按钮仍高亮。
- 打包版证明：`verify.ts up --app "tmp/<install>/Video Notes.app" --no-build`，断言 `nav-lab` 不存在、`window.vnote.lab === undefined`、`vnote-media://lab/<id>` 返回 404。

## Gotchas

- **Lab 的音频协议只读 `audio.wav`**：`vnote-media://lab/<id>` 固定映射 `<labRoot>/<id>/audio.wav`，样本没有音频时页面禁用播放。
- **实验目录必须带 `segtext-*.json`**：只有 `labels-*.json` 的目录会被拒绝（缺段级文本无法判语气词）。
- **`refine` 与语气词规则只存在于 Lab**：`apps/desktop/src/main/dev-lab/` 与 `shared/lab-*.ts`，不进入 `packages/core` 正式管线；不要在视频页断言同样的聚类数。
- **`refine` 是自适应 k**：`cut 0.65` 只是种子 < 8 时的回退值；30 分钟样本上是 BIC + silhouette 选出 7 簇，不能拿固定切点解释。
- **主播簇数依赖样本自带锚点**：只有实验目录里带 `gt-anchors*.json` 时摘要才显示 `主播簇 A→B`，否则是 `—`。
- **样本目录在仓库 `tmp/verify/lab/`**：不进笔记库、不受 `VNOTE_HOME` 隔离；清理由人工删除。
