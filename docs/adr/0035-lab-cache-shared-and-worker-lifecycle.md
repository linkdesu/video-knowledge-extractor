# Lab 缓存跨分支共享：位置收归用户级 + 三种模式；worker 一次任务一个进程

r53 的键已经能保证「同内容 + 同参数 = 同条目」，但条目落在每个 worktree 自己的 `tmp/verify/lab`：A 分支算完，切到 B 分支同一份样本仍是全量重算（本机 6 分钟样本约 53 秒）。另一个从 r48 就存在的问题是：每次未命中 fork 出的 `lab-worker.js` 在回完 `done` 之后既不自己退出，主进程也不 kill，sherpa/onnxruntime 的原生线程让它的时间循环永远不空 —— 每多一次未命中就多一个常驻进程，直到 app 退出。

## Status

已接受（accepted，2026-10-30，r54）。不做缓存界面（命中标识 / 强制重算按钮）与缓存淘汰。

## 决定

### 1. 共享位置：`~/.cache/video-notes/lab-cache`

默认根目录从「仓库 tmp/verify/lab」改为用户级目录：

- 解析顺序：`VNOTE_LAB_CACHE_DIR`（显式覆盖，测试/特殊布局用） > `$XDG_CACHE_HOME/video-notes/lab-cache` > `~/.cache/video-notes/lab-cache`（Windows 是 `%USERPROFILE%\.cache\video-notes\lab-cache`）。
- 理由：它必须与**仓库**无关（不然换 worktree 就换目录），又要和 dev 模式已有的模型兜底目录 `~/.cache/video-notes/models` 同形，且不落在笔记库里（`tmp/verify/lab` 也不在笔记库，但会被 worktree 切走）；`~/.cache` 不进 git、不进证据目录（r50 的 secrets-gate 扫描范围外，但也不放任何凭据）。
- 样本目录、`marks-<id>.json`、`audio.wav` 都跟着根目录走：条目即样本目录（r53 的决定不变），命中路径仍然只读 JSON/音频，不加载模型。

### 2. 三种模式：`--lab-cache=shared|isolated|cold`（环境变量 `VNOTE_LAB_CACHE`）

| 模式 | 根目录 | 读已有条目 | 写 | 用途 |
| --- | --- | --- | --- | --- |
| `shared`（默认） | 共享目录 | 是 | 共享目录 | `bun run dev` 不带参数：所有 worktree 共用一份 |
| `isolated` | 每次启动 `mkdtemp(tmpdir()/vnote-lab-isolated-*)` | 只读自己 | 只写临时目录 | QA / verify：断言「第一次跑」，绝不读写共享缓存 |
| `cold` | 共享目录 | 否（`reason: "cold"`） | 共享目录（覆盖旧条目） | 强制全量重算，并把新结果写回共享缓存 |

- 命令行优先于环境变量；拼错（`--lab-cache=share`）或 `--lab-cache` 缺值直接抛错，绝不静默回退到 shared —— 否则一次手滑就会污染共享缓存。
- `isolated` 的 `sharedRoot` 是 `null`：代码里没有「顺便看看共享目录」的分支，QA 证据因此可复现。
- `cold` 命中判定完全跳过（不读 `sample.json`），但仍走同一条发布路径，所以「冷跑一次 → 任何人再跑都命中」。

### 3. 跨进程并发：整目录 rename + 有限重试 + fsync

两个 worktree 同时算同一个键时，双方都会「写自己的 `.tmp/<键>-XXXX` → 整目录 rename 到键路径」。rename 本身原子，但目标已存在时 POSIX 返回 `ENOTEMPTY`、Windows 返回 `EPERM`。发布流程：

1. `fsyncTree(tmpDir)`：发布前把所有产物刷盘（rename 只保证目录项顺序）；
2. `rename(tmpDir, target)`；撞上 `ENOTEMPTY|EEXIST|EPERM|EACCES|EBUSY` 就把当前 target 挪进 `.tmp` 再重试（≤4 次）；
3. 重试用尽且 target 已有 `sample.json`：说明对方已发布完整条目，**接受对方那份**，丢掉自己这份（同一个键 = 同一份内容，结果等价）；否则如实抛错，调用方重算；
4. 发布后 `fsync` 父目录（Windows 目录 fsync 不可用则忽略，NTFS rename 自身有日志）。

因此键路径上只可能是某一方写完整的那份；`.tmp` 里的 stale 目录删不掉也只是残留，启动时 `sweepTempEntries` 回收。`analysis-cache-race.test.ts` 用两个真实进程各发布 25 次同一个键来守这条不变量。

### 4. 迁移：只复制，不删旧目录

以 `shared` / `cold` 启动时，若存在旧的 `<worktree>/tmp/verify/lab`：

- 旧目录里 `[a-z0-9]+` 且 `sample.json` 的 `id` 与目录名一致的条目（r53 键与 r48 路径指纹都满足）；
- 共享目录**缺失**该键时，复制到 `.tmp` 再走同一条 publish（并发启动的两个 worktree 也只会留下完整副本）；
- 共享目录已有（哪怕自检不过）就跳过 —— 不能拿旧副本覆盖别的分支刚算好的新条目；
- `marks-<id>.json` 跟着搬，但目标已有 marks 时不覆盖；
- 旧目录一个字节都不删（用户数据），清理留给人工；搬运放在 `setImmediate` 里跑，不挡首帧；幂等，下次启动只会全部 skip。

不选「直接重算」：条目里是几十 MB 的 `audio.wav` 与逐段嵌入，重算是分钟级；复制是秒级且完全可逆。

### 5. worker 生命周期：一次任务一个进程，任务结束就死

- worker 侧（`serveLabWorker`）：回 `done`/`error` 后置 `finished`，收到主进程的 `{type:"ack"}` 才 `process.exit(0)`；`ack` 早于完成时忽略（不能把任务扼杀在半路）。先 ack 再退保证结果消息不会因为 `process.exit` 丢。
- 主进程侧（`createLabWorkerHost`）：收到 `done`/`error` 即 resolve/reject，发 `ack`，并起宽限计时器（默认 2s）——worker 不自己退就 `kill`；`exit` 事件清理计时器并把 `live` 归零，退出码写日志（`Lab worker 退出`，`code`、`live`）。
- `dispose()`（`app.on("before-quit")`）无条件 kill 所有还活着的 worker：原生线程不认 Node 的退出钩子。
- 日志：`Lab worker 启动` / `Lab worker 退出`（含 `key`、`code`、`live`），worker stderr 另有 `[lab-worker] start|done|error` 行。
- 不复用 worker：复用会把上一份样本的原生句柄留在进程里，而本机模型本来就严格串行。

## Considered Options

- **共享目录放 `VNOTE_HOME` 或仓库 `tmp/`**：前者被 verify 每次指向临时 home（共享失效），后者换 worktree 就换目录（就是 r53 的问题）。
- **用文件锁串行化发布**：需要一个跨进程锁的失效/陈旧策略（pid 复用、崩溃残留），而整目录 rename + 重试已经能在无锁下保证「键路径永远是完整条目」。
- **cold 用临时目录再回灌**：多一次整目录复制，且回灌本身又是一次并发写；直接写共享目录更简单。
- **isolated 结束后自动删除目录**：证据要能复查「这一跑到底算了什么」，目录留在 tmp 由系统清理。
- **worker 常驻复用（池化）**：省模型加载，但与本机模型严格串行、样本之间原生句柄隔离冲突；r48 的一次性进程语义保留，只补上「用完必死」。

## 后果

- A worktree 算完的条目，B worktree 的同一份样本直接命中（日志 `Lab 分析缓存命中` 带 `cacheMode=shared`、`root` 与毫秒级 `elapsedMs`）。
- QA 不再可能「因为共享缓存而假命中」：`verify.ts up` 默认 `--lab-cache=isolated`，`state.json#labCache` 可审计。
- 连续 N 次未命中后进程数回到 0（`liveWorkers()` 与 `Lab worker 退出` 日志可查）；app 退出无残留 worker。
- 共享目录会一直变大（不做淘汰）；旧的分支级目录保留原样，需要时人工删除。
- `sample.json` 不变（schema 仍然 1），已有条目无需迁移格式。
