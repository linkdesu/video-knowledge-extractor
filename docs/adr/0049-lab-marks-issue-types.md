# Lab 标注格式扩展：三类问题类型，值域只增不改

issue #100：`LabMarks = Record<string, "A" | "B" | "both">` 只能回答「谁的说话人对」，11-03 验收时遇到的三类问题（重叠归错人、误判重复、未忽略的回应语）标不出来，只能选「都错」。这是**不可逆**改动：`marks-<id>.json` 里存的是 Link 本机上几十条人工标注。

## Status

已接受（accepted，2026-11-03，r74；编号 0049 —— 0046/0047/0048 已被 PR #104/#105/#106 占用）。只扩展 `marks-<id>.json` 的值域与界面按钮；文件位置、文件名、扁平 map 结构、淘汰/去重时连带删 marks、导入搬运规则都不变（ADR-0034/0035/0036/0037 继续有效）。

## 决定

### 1. 值域只增不减，文件结构不动

- `LabMark = "A" | "B" | "both" | "overlap_wrong_speaker" | "false_duplicate" | "backchannel_not_ignored"`（`apps/desktop/src/shared/lab.ts`），文案集中在 `LAB_MARK_LABEL`。
- 磁盘上仍然是「行起点毫秒 → 标记字符串」的扁平 JSON，不加 `version` 外壳、不改文件名。旧的 `{"4000":"B","9000":"both"}` 对新区值域天然合法，**不需要任何迁移代码路径**：`normalizeMarks()` 读进来就是同一份 map，读路径不写盘（旧文件字节不变，端到端 md5 前后一致）。
- 一行仍然只有一个标记：三类问题类型是 A/B/both 之外的**替代**选项，不叠加。理由见 Considered Options。

### 2. 安全写盘：共用校验器 + 拒绝非法容器 + 原子替换

- `normalizeMarks()`（`apps/desktop/src/main/dev-lab/sample-store.ts`）同时被 `readMarks` / `writeMarks` 使用：键必须是毫秒数字串，值必须属于值域，其余条目跳过；已知标记一条不删——保存某一行的新标记时，其余行（含 r48–r73 写的 A/B/both）原样保留。
- `writeMarks` 先拒绝非法容器：IPC（`dev:lab:marks:set`）只带 TS 类型、没有运行时校验，`null` / 数组 / 字符串若被归一成 `{}` 会整份清空标注。现在直接抛错，界面显示「保存标记失败」，磁盘保持原样。
- 写文件改成同目录 `marks-<id>.json.tmp-<pid>` + `rename`：崩溃不会留下半截 JSON 让整份标注读不出来。

### 3. 界面：差异行两组按钮，标记区独占一行

- 「谁对」= `B 对` / `A 对` / `都错`；「问题类型」= `重叠归错人` / `误判重复` / `未忽略回应语`。文案全部走 `LAB_MARK_LABEL`，渲染层只按值域生成按钮。
- 固定 testid：`lab-mark-A` / `lab-mark-B` / `lab-mark-both` 保留；新增 `lab-mark-overlap_wrong_speaker` / `lab-mark-false_duplicate` / `lab-mark-backchannel_not_ignored`。
- 布局：`.vn-lab-row` 仍是每行一个 grid，但标记区不再占第 7 列，而是 `grid-column: 1 / -1` 落到差异行的第二行、整行宽。实测（1280×828、行宽 694px）：占第 7 列时字幕文本列只剩 132px（r74 之前 216px）；改为第二行后文本列 370px，且三行的文本列左缘（480px）与宽度完全一致——差异行不再让文本横向跳动。非差异行行高 45px 不变，差异行 84px。

### 4. 渲染层不得丢标记：切样本 / 卸载先 flush

- 标记保存有 300ms 防抖。原实现只 `clearTimeout`，切样本或离开页面时挂起的那一次写入会静默消失（切样本时还会把「旧样本整份 marks + 新键」写进新样本）。
- 现在 `pendingMarks` + `flushMarks()`：`loadSample` 先 flush 再读新样本，`sampleId` 与 `marks` 一起切换；组件卸载也 flush。`marks` 读取失败只清空显示 + toast，不再把上一份标记留在新样本上。

### 5. 缓存淘汰不受影响

淘汰/去重按条目 id 删 `marks-<id>.json`（ADR-0037 的 `removeEntry`），与文件内容无关，旧值文件与新值文件走同一条路径。回归测试同时覆盖两种内容。

## Considered Options

- **加 `{"version":2,"marks":{…}}` 外壳 + 迁移**：看起来更「正规」，但对不可逆数据是净损失。旧安装（0.1.32 及更早）读这种文件会得到空 marks（`Object.entries` 只看到 `version` / `marks` 两个键），用户下一次点任何标记就会把整份标注**整份覆盖成 `{}`**；而值域扩展下旧安装最多丢新增的那几个值，A/B/both 全部保得住。迁移还需要「读时升级、写时换格式」两条易错路径，收益为零。
- **标记拆成 `{verdict, issues[]}` 双维度**：能表达「A 对 + 误判重复」，但每行要变成多选，界面与统计口径都要重设计，而三类问题在语义上本来就替代 A/B 判定（重叠归错人时「谁对」没有答案）。等到确实需要叠加时，用新文件名（`marks-v2-<id>.json`）落地，不要原地改结构。
- **把「取消标记」一起做**：本 issue 没要求；没有取消路径时 `writeMarks` 收到的永远是超集，天然不会删；引入取消就要同时定义空值语义，属于另一件事。
- **保留第 7 列、只把列宽上限压到 232px**：差异行/非差异行对齐了，但实测字幕文本列被压到 132px，读中文都困难；标记区换行成第二行后文本列回到 370px，代价只是差异行高 +39px。

## 后果

- 旧标注文件零手工处理：加载后标记原样显示，读不写盘；端到端验证 79 条旧文件写入一条新值后 `{before:79, after:79, changed:[该行], missing:[]}`。
- 新值可保存并读回；同一行切换标记即覆盖该行的旧标记，别的行不受影响。
- 降级风险（已接受并在 PR 写明）：用 r73 及更早的构建打开新格式文件并点任一标记，会把三类问题类型的标记过滤掉（A/B/both 不受影响）。本轮同时把四个包版本升到 0.1.33，双机安装由 Link 执行（本轮未安装）。
- 未来再加问题类型仍是纯增量：扩 `LAB_ISSUE_TYPES` + `LAB_MARK_LABEL`，不动磁盘结构与迁移。

## 证据

- `apps/desktop/src/main/dev-lab/lab-core.test.ts`：78 条旧标注原样加载且文件字节不变；三类新值保存读回；在旧标注上补记新值后一条不丢；`null` / `undefined` / 数组 / 字符串 / 数字 一律抛错且文件字节不变。
- `apps/desktop/src/shared/lab-view.test.ts`：问题类型与 A/B 一样按行起点毫秒对齐。
- `apps/desktop/src/main/dev-lab/cache-maintenance.test.ts`：淘汰时新旧两种内容的 `marks-*.json` 都随条目删除。
- `tmp/verify/r74-label-issue-types/`：隔离 Lab 缓存下的真实 Electron 验收（旧值文件 → 界面 → 点击问题类型 → 文件与读回；79 条旧文件；防抖窗口内切样本/卸载不丢标记；布局实测；`detect` primary 0、`doctor` healthy）。
- `.omp/skills/verify-video-notes/features/diarization-lab.md`：验收要点同步 6 个标记与 testid。
