# 行标注升级为记录 + 旁挂文件：一致行可标注，并记下实际说话人

issue #110：验收台的「谁对 / 问题类型」只出现在差异行，Link 遇到的「相邻两行标为一致、实际都是 speaker-1」无法记录；每句也没有地方记「实际说话人」。这是**不可逆**方向上的改动（Link 本机已有几十条人工标注），所以落地方式先按 ADR-0049 的既定规则选：不原地改结构。

## Status

已接受（accepted，2026-11-04，r77）。`marks-<id>.json`（r48 起，值 = 单个标记字符串）**保持原样、只读不改**；新增 `annotations-<id>.json` 承载 `{ mark?, speaker? }` 记录。ADR-0034/0035/0036/0037 的缓存键、淘汰、搬运规则继续有效，只把「跟着条目走的人工数据」从一份扩成两份。

## 背景

1. r74 把 `LabMark` 扩成「谁对 / 问题类型」六值共享一条单选轴（ADR-0049），一行只有一个标记。
2. 实际说话人是**另一个维度**：A/B 两套方案可能都判对（一致行），但这一句其实换了人；也可能都判错。它不能挤进同一条单选轴，必须与 `mark` 并存。
3. ADR-0049 的 Considered Options 已明确写下结论：「等到确实需要叠加时，用新文件名（`marks-v2-<id>.json`）落地，不要原地改结构」。原因是反向：旧安装读到对象值会得到空 marks，用户下一次点任何标记就把整份标注覆盖成 `{}`——那是真实的数据丢失，而不是优雅降级。

## 决定

### 1. 磁盘：旁挂记录文件，旧文件只读

- `annotations-<id>.json`：`{ "<行起点毫秒>": { "mark"?: LabMark, "speaker"?: "speaker-<n>" } }`。两个字段各自可空，两个都空的记录不落盘。
- `marks-<id>.json` 继续存在且**永不改写**：旧安装降级后仍看得到自己那份；本应用降级前写下的标注不会消失。
- 读（`readMarks`）：`annotations-<id>.json` 存在即**完整快照**（首次保存时已把旧 marks 全集并入），直接用它；不存在才读旧 `marks-<id>.json`，旧标量经 `normalizeMark` 读成 `{ mark }`。
- `annotations-<id>.json` 存在但解析失败 → **抛错**（界面走既有「读取标记失败」toast），绝不悄悄退回旧文件：退回会让下一次保存用旧内容盖掉新记录。
- 写（`writeMarks`）：仍先拒绝非法容器（`null` / 数组 / 字符串），仍是同目录 `.tmp-<pid>` + `rename` 原子替换，只写 `annotations-<id>.json`。
- 清理与搬运跟着条目走：`removeEntry` 删条目时同时删两份；`migrateLegacyEntries` 两份都复制（目标已存在则不覆盖）；`runtime.annotationsPath()` 指向新文件。

### 2. 值域与校验

- `LabLineNote = { mark?: LabMark; speaker?: string }`，`LabMarks = Record<string, LabLineNote>`；`normalizeMark` 同时接受旧标量、记录、以及「只有一半合法」的记录（非法字段单独丢弃）。
- 说话人只认 core `assignSpeakers` 的产物：`/^speaker-[1-9]\d{0,3}$/`（`isLabSpeakerId`）。不认识的 id 一律丢弃，避免把任意字符串写进标注。
- 记录里只存编号、不存方案名：编号按总时长排序重排，同一段录音在两套方案里 `speaker-1` 通常就是同一个人（差异只在合并/错分处）。界面用**当前方案 B** 的说话人列表提供选项，行内说话人列也在同一屏，切方案后按原文显示已记录的编号，不猜测、不改写。
- `mergeMark(marks, key, patch)` 是唯一的写入路径：`undefined` 不动字段、`null` 删字段、两个字段都空则删整条键，返回新 map。清除「实际说话人」就是 `{ speaker: null }`，不写空串。

### 3. 界面：每行都能标注，密度优先

- 差异行保持 r75 的常驻标记条（不改既有肌肉记忆）；一致行在被选中（点击行、`J`/`K`、时间轴定位）时展开同一条标记区；未选中且无标注的一致行保持紧凑行高，只给一个「可标注」的可见暗示，已有标注时显示紧凑摘要。
- 「实际说话人」用仓库 `Select`（portal + `role=listbox`）从**当前方案 B 的说话人列表**里选，另加「未标注」清除项；选项带与行内说话人列一致的颜色点。
- 键盘语义沿用 r75：`role="radiogroup"` + `aria-checked` + roving tabindex + `←↑→↓` 立即落盘；行级 `Enter`/空格不吞控件、控件也不吞行。
- 视觉体系不新增 token：沿用 `.vn-lab-mark`（26px / 6px 圆角 / 选中态 violet 半透明底 + `#c4b5fd` 文本）。

## Considered Options

- **原地把值换成对象（`{"12000": {"mark":"A"}}`）**：省一个文件，但旧安装读到对象值 → 空 marks → 下一次点击整份覆盖。ADR-0049 已否，本轮同样否。
- **同一文件里用 `"<ms>:speaker"` 前缀键**：旧 `normalizeMarks` 会跳过非数字键，看似兼容；但旧安装保存的是它自己的全量 map，仍会把 `:speaker` 键整份抹掉——只多了一个难解释的键形状。
- **由实际说话人自动推导「谁对」**：能少点两次，但会把人工判定改成机器判定，并在两套方案都给错时无法表达；标注是事实记录，不自动推导（界面可以显示推导出的提示，但不写盘）。
- **把「实际说话人」塞进 `mark` 单选轴的第七个值**：一行可能同时「A 对」和「实际是 speaker-3」，单选轴表达不了。

## 后果

- Link 现有 `marks-<id>.json` 零改写：加载后标记原样显示（读路径不写盘），首次保存时整份并入 `annotations-<id>.json`。
- 降级行为：用 r76 及更早的构建打开样本，只会看到旧 `marks-<id>.json` 的内容；新记录不可见但**不丢**，升回来即恢复。因此本 PR 不打 `irreversible` 标签（文件结构未原地改动）。
- 一条样本的标注可能分散在两个文件：`annotations-<id>.json` 一旦生成即为唯一真相，旧文件从此是历史快照。
- 未来再加维度（例如「置信度」）仍是纯增量：扩 `LabLineNote` + `normalizeMark`，不动文件名与位置。

## 证据

- `apps/desktop/src/shared/lab.test.ts`：旧标量/记录/半合法记录归一；`speaker-0`、`Speaker-1`、尾随空格一律拒绝；`mergeMark` 的字段保留、`null` 清除、删空键、不改入参。
- `apps/desktop/src/shared/lab-view.test.ts`：记录贴到行上（`mark` 与 `speaker` 独立），一致行可只有说话人，旧标量仍能贴行。
- `apps/desktop/src/main/dev-lab/lab-core.test.ts`：记录写进 `annotations-*` 且不产生 `marks-*`；78 条旧标量读成记录且文件字节不变；在旧标注上补记后 79 条齐全且旧文件字节不变；记录文件存在即权威（旧键不复活）；记录文件损坏抛错；非法容器抛错且两份文件字节不变。
- `apps/desktop/src/main/dev-lab/cache-maintenance.test.ts`：淘汰条目时 `annotations-*.json` 一起删，未淘汰的保留。
- `apps/desktop/src/main/dev-lab/legacy-migrate.test.ts`：旧分支目录搬运时 `marks-*` 与 `annotations-*` 都跟着条目走。
- `tmp/verify/r77-label-consistent-speaker/`：真实 Electron 验收（一致行标注、实际说话人、刷新与重启读回、行高与宽度、`detect` primary 0）。
