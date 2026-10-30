# Lab 缓存收尾：上限淘汰、同内容去重、强制重算与命中可见

r54 把缓存根收归 `~/.cache/video-notes/lab-cache` 并修掉 worker 泄漏，但留了四个尾巴：共享目录只增不减（一个 6 分钟样本 ≈ 几百 MB）；界面看不出这次是命中还是重算、也不知道花了多久；想重算只能重启 app 换成 `--lab-cache=cold`；同一个视频在模型 mtime/schema 变化后会以新键再存一份，列表里出现两条一模一样的样本。r55 把这四件事收掉，并把「命中 = 未加载模型、未解码音频」写进日志与界面。

## Status

已接受（accepted，2026-10-31，r55）。取代 ADR-0035 里「不做缓存界面与淘汰」的范围声明；r54 的位置、模式、并发发布与 worker 生命周期决定不变。

## 决定

### 1. 上限淘汰：条数 / 总字节 / 存活时间，启动时与每次发布后各跑一次

实现：`apps/desktop/src/main/dev-lab/cache-maintenance.ts`。

- 默认上限 `LAB_CACHE_LIMITS`：**200 条 / 20 GiB / 30 天**。够放几十个长样本，又不会把用户磁盘吃光。
- 覆盖方式：`VNOTE_LAB_CACHE_MAX_ENTRIES`、`VNOTE_LAB_CACHE_MAX_BYTES`、`VNOTE_LAB_CACHE_MAX_AGE_DAYS`；取值必须是非负整数，`0` 表示该项不限制，其它取值（`-1`、`1.5`、`many`）**直接抛错**，与 `--lab-cache` 拼错即失败同一口径。
- 顺序：先淘汰 `now - createdAt > maxAgeMs` 的条目（`reason: "age"`），再对剩下的按 createdAt 从新到旧装填，超出条数（`"count"`）或总字节（`"bytes"`）的继续淘汰。
- 年龄取 `sample.json#createdAt`；没有或解析不了（r53 之前的条目、半截目录）退回目录 mtime。
- 不参与淘汰：`.tmp`（归 `sweepTempEntries`）、`marks-*.json`、目录名不满足 `[a-z0-9]+` 的东西。
- `protect`：刚发布的键先无条件计入已保留，再让其它条目竞争剩余额度 —— 上限严格成立，且自己这一轮算完的条目不可能被自己删掉。
- 执行点：`shared` / `cold` 启动时（`isolated` 是每次新建的空目录，没必要）与每次 `publishEntry` 成功之后。删不掉的条目记进 `failed`、留到下一轮，绝不让淘汰失败把分析判成失败。
- 日志：`Lab 缓存：按上限淘汰旧条目`（`removed` / `reasons` / `kept` / `keptBytes` / `failed`）；启动行的 `Lab 缓存就绪` 里带 `limits`，一眼能看出这一跑的上限。

### 2. 同内容指纹只存一份

- 键 = 内容指纹 + 规范化参数（r53 不变），所以「同内容同参数」天然只有一个条目；重复来自**参数口径变化**（模型 mtime、schema 升级）产生的第二个键。
- 发布成功后调用 `removeDuplicateSources(root, sourceHash, keepKey)`：删掉 `sample.json#analysis.sourceHash` 相同、键不是 `keepKey` 的条目，日志 `Lab 缓存：同内容旧条目已删除`。
- 展示层 `listSamples` 再按 `sourceHash` 去重、保留最新的条目 —— 防的是「本次发布之前就已经存在的重复」（旧数据不需要等下一次重算才从列表里消失）。
- 没有 `analysis` 戳的 r53 之前条目无法判定内容指纹，**既不删也不合并**。
- 只在 `shared` / `cold`（`sharedRoot !== null`）做：isolated 的临时目录里不会有别人写的重复条目。
- 命中路径不做去重：删除条目会让正在读它的另一个 worktree 失去音频/JSON；宁可等下一次发布再收。

### 3. 强制重新生成：单次操作，不是第四种缓存模式

- 契约：`lab.importPath(sourcePath, { force: true })` → 不读已有条目、重新分析、成功后整目录覆盖旧条目。
- `labProbeDecision({ reads, force })` 是唯一判定点：`force` 优先于 `cold`，日志 `reason: "forced"`（`cold` 仍是 `"cold"`），`未命中` 行另有 `forced` 字段。
- 失败时旧条目**原样保留**：覆盖只发生在 `publishEntry` 之后（整目录 rename），半成品进 `.tmp` 后丢弃。
- 为什么不复用 `--lab-cache=cold`：模式是启动期概念，重算是「这一次」的操作；按钮必须能在同一个会话里对当前样本重算，且不影响其它样本的命中。

### 4. 命中可见：`LabImportResult` + 状态行 + 可读日志

- 导入返回值从 `{ sampleId }` 扩为 `{ sampleId, hit, reason, hashMs, elapsedMs, sourceHash }`，界面据此显示：
  - 命中 → `命中缓存 · 12 ms · 未加载模型、未解码音频`（青色）；
  - 未命中 → `重新分析 · 3.6 s` / `强制重新生成 · 2.9 s` / `cold 模式重算 · …`（muted，`reason` 放 `title`）。
  - 耗时格式：`< 1000ms` 用毫秒，`< 60s` 用一位小数秒，再长用 `formatTime`。
- 命中日志从 `Lab 分析缓存命中` 改为 **`Lab 分析缓存命中：未加载模型、未解码音频`**，同时保留 `modelLoads: 0` / `decodedSegments: 0` 便于机器 grep —— 只打 0 计数读起来像「没测」，说人话才是验收要的东西。
- 命中仍然不 fork worker：一次命中只有哈希 + 一次目录自检 + 读 JSON。

## Considered Options

- **按 LRU（最后访问时间）淘汰**：每次命中都要 touch 条目（写放大），跨 worktree 还会互相覆盖 mtime；V1 用「创建时间 + 上限」已经够用，且计划可单测。
- **按源路径去重**：同一份内容从不同路径导入时识别不出来，正是要解决的问题；内容指纹才是唯一可靠的判据。
- **淘汰做成后台定时任务**：多一个常驻计时器与生命周期要管；启动 + 发布两个时机已经覆盖「长时间不开 app」与「一次会话里连续导入」两种增长路径。
- **命中时也清理重复条目**：会删掉别的 worktree 正在读的目录（音频/JSON 立刻失效），收益只是让磁盘早点收敛，不值得。
- **把强制重算做成 `--lab-cache=force`**：模式是启动期开关，无法对「当前这一条样本」生效；单次操作的语义更适合放 IPC 参数。
- **去重时连 marks 一起删**：marks 是用户标注，键相同的内容重算后还能复用；保留孤儿 marks 的代价只是几 KB。

## 后果

- 共享目录有界：默认最多 200 条 / 20 GiB / 30 天，超出部分按最旧优先删除，日志可审计。
- 同一份视频在列表里只有一条（即使历史上因参数变化存过多个键），磁盘上的旧键在下次发布该内容时被删掉。
- 界面一眼能看出这次是命中还是重算、花了多久；「强制重新生成」一次点击即可覆盖结果，且不影响其它样本的缓存。
- 命中日志与界面文案都明说「未加载模型、未解码音频」，不再需要靠 `modelLoads=0` 猜。
- 被淘汰条目的 `marks-<id>.json` 会变成孤儿文件（几 KB），重算同一内容时正好复用；不做额外清理。
- 默认上限是拍出来的经验值（200 条 / 20 GiB），不是压测结论；需要时用环境变量调，不需要改代码。
