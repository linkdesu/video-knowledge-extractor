# Lab 缓存验收收尾：worker 结算点、删条目连带 marks、Windows CI 横杠分支

PR #66 验收（issue #74）留了三条小问题：连续两次未命中时会短暂出现两个分析 worker；淘汰条目后 `marks-<id>.json` 变成孤儿文件；`feat-r54-…` / `fix-r57-…` 这类横杠分支推送后不跑 Windows CI。

## Status

已接受（accepted，2026-10-31，r57）。推翻 ADR-0036 里「被淘汰条目的 marks 保留成孤儿」的决定与「去重时连 marks 一起删」的否决理由；补上 ADR-0035 的 worker 生命周期只保证「不泄漏」、没保证「不重叠」的缺口。位置、模式、并发发布、上限淘汰策略本身不变。

## 决定

### 1. worker 的结算点 = 进程 exit（同一时刻最多一个分析 worker）

证据（`tmp/verify/r55b-lab-cache/app.log`，r55 验收时连续未命中）：

```
17:20:24.162Z Lab worker 启动 key=… live=1
17:20:32.204Z Lab worker 启动 key=… live=2   ← 前一个还没退
17:20:33.959Z Lab worker 退出 key=… code=0 live=1
```

- 原因：`createLabWorkerHost().run()` 在收到 `done` / `error` 消息时就结算 Promise，主进程紧接着 fork 下一个 worker；而 ack → 真正 exit 之间还有一段肉眼可见的延迟（sherpa/onnxruntime 的原生线程），于是两个含模型的进程并存 1–2 秒。
- 决定：`run()` 只在 `exit` 事件里结算。`done` / `error` 只记录结果（`outcome`）并回 ack + 起宽限 kill 兜底；exit 时若没有结果，就用退出码错误结算，有结果则按结果 resolve/reject。
- 契约变化：`await run(...)` 返回即代表**这个 worker 进程已经没了**，调用方（每次未命中一个进程）可以直接 fork 下一个。导入槽位释放因此比之前晚几毫秒到 2 秒（宽限期），换来内存峰值只有一个本地模型。
- 退出日志统一记录：`Lab worker 退出`（`key` / `code` / `live`），`code === 0` 且成功才 info，其余 warn —— 崩溃路径（没等到 done 就退出）以前一条日志都没有。
- 回归测试：`apps/desktop/src/main/dev-lab/lab-worker-host.test.ts`「连续未命中不重叠：run 结算时上一个 worker 已退出，live 从不超过 1」，用真实子进程连续 5 次，断言每次 `run` 结算后 `live() === 0`、启动日志里的 `live` 恒为 1。

### 2. 删条目就连带删它的 marks

- 决定：新增 `removeEntry(root, id)`（`cache-maintenance.ts`），删 `<root>/<id>` 之后删 `marks-<id>.json`。所有删条目的路径都用它：上限淘汰（`evictLabCache`）与同内容去重（`removeDuplicateSources`）。
- 理由：条目目录一没，marks 在界面上永远读不到（列表按条目 id 取标记），留着只是孤儿文件。ADR-0036 认为「重算同一内容能复用」，但重算会生成**当前参数的新键**，旧键的 marks 不会被读到，等于既占文件又没用。
- 计划阶段不变：marks 不参与条数 / 总字节统计，`.tmp`、非条目文件不碰。
- 可审计：`evictLabCache` 的结果新增 `marks`（本次连带删掉的 marks 文件数），并进 `Lab 缓存：按上限淘汰旧条目` 日志。
- 回归测试：`cache-maintenance.test.ts`「真的删掉被淘汰的目录与它的 marks，保留其余目录与 marks」「淘汰后不留孤儿 marks：每个 marks-*.json 仍指向存在的条目」「删掉的旧键条目的 marks 一起删，保留键与其它条目的 marks 不动」。

### 3. Windows CI 覆盖横杠命名分支

- `.github/workflows/windows-build.yml` 的 `push.branches` 从 `main` / `feat/**` / `fix/**` 扩为再加 `feat-*` / `fix-*`。仓库实际用的分支名是 `feat-r54-shared-lab-cache`、`fix-r57-lab-cache-followups` 这种横杠形式，之前推送后 Windows 构建根本不触发（`install:local` 因此拿不到 CI 产物）。
- 验收方式：本分支推送后 `gh run list --workflow windows-build.yml` 能看到 `fix-r57-lab-cache-followups` 的运行。

## Considered Options

- **在 `register.ts` 里再串行一道（`running` 已存在）+ 等 worker 退出**：IPC 层已经有「一次只允许一个导入」的槽位，重叠加成的是进程生命周期与槽位释放不同步；修在 host 层才是根因，且对任何调用方都成立。
- **done 之后 `await` 一个固定 sleep 再结算**：靠猜原生线程收尾时间，慢机器上还是会重叠。
- **`process.kill` 立即杀（不等 worker 自退）**：ACK → 自退本来是为了不丢消息，杀掉后 `code` 也看不出 worker 是否正常收尾；宽限期 kill 已覆盖卡死的情况。
- **只在上限淘汰时删 marks，去重保留**：同一件事出现两种语义，去重删的条目同样让 marks 变成孤儿；统一走 `removeEntry` 成本一样。
- **把 marks 迁移到保留键（`keepKey`）**：去重时两侧的段边界可能因参数变化不同，迁移过去也可能一条都对不上，还要处理「保留键已有 marks」的冲突；不如随条目一起删。
- **CI 改成 `branches: ["**"]`**：会把 `main` 之外的临时分支、依赖更新分支都拉起来打包；显式列出两种命名更可控。

## 后果

- 本机模型峰值内存为一个分析 worker；连续未命中不再出现 `live=2`。
- 共享缓存里不再有指向不存在条目的 `marks-*.json`；被删条目的标注随之消失（它本来就不可达）。
- 横杠分支推送会跑 Windows 构建，`install:local` 能从 CI 产物取安装包。
- `run()` 的结算比 done 晚一点（ack → exit，最长一个宽限期），导入操作的可感知耗时几乎不变。
