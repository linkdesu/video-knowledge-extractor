# Lab 缓存发布竞争：不再用一次 `existsSync` 判死，改为预算内抢、预算外用对方那份

issue #85（r62 在 8 路并行全量下观测到）的现象是 `analysis-cache-race.test.ts` 偶发红：两个 writer 子进程里有一个**退出码 1**，而不是断言内容不符。r66 用带 errno 的复现脚本（`tmp/r66/repro/`）拿到了确切的失败签名：

```
publish failed: iter=16 code=ENOTEMPTY syscall=rename
  .tmp/<键>-XXXXXX -> <labRoot>/<键>
```

## Status

已接受（accepted，2026-10-31，r66）。

## 根因

`publishEntry()`（r54）在 rename 撞上 `ENOTEMPTY/EEXIST/EPERM/EACCES/EBUSY` 时，把当前目标挪进 `.tmp` 再重试，第 4 次失败时用 `existsSync(target)` 决定「采用对方那份」还是「如实抛错」。

问题在于**这个 `existsSync` 读的不是状态，而是竞争窗口的一瞬**：对端在自己的「把条目挪走 → 自己 rename 到位」之间，键路径有几微秒到几毫秒不存在。此时读到 `false` 就抛错，等于把一次正常的发布竞争报成 Lab 分析失败。放大窗口的因素只有调度（CPU 抢占、fsync 抖动），所以失败率随机器负载剧烈波动：同一份测试实测从 0/30 到 23/30 轮不等。

## 决定

1. **竞争用时间预算，而不是尝试次数**。`ENOTEMPTY/EEXIST/EPERM/EACCES/EBUSY` 一律只当「等一等再试」（`RENAME_RETRY_CODES`），重试方式按**目标此刻在不在**分流：目标有条目 = 被别人的条目占着（Windows 上目录 rename 撞已有目录就是 EPERM），挪走目标再抢，预算 800 ms、前几次不退避、连续撞空才让 1–5 ms；目标空着 = 只是句柄/杀软没放手，原地让 25 ms，预算 3 s，绝不动别人的目录。这两个判断只决定「怎么等」，从不决定「要不要报错」。
2. **预算用尽后不再靠 `existsSync` 判死**：先 `settlePublishedEntry`（再给 1 s 处理句柄延迟，目标上有对方 rename 到位的完整条目就采用，空着就把自己 rename 进去），仍谈不拢才交给 `resolveContention` 做最终裁决。只有在「目标一直空着、自己的 rename 也一直失败」时才抛「发布条目竞争超时」。这样「另一方正在发布」不会被误报成失败。
3. **键路径不变量收敛到 `resolveContention`**：目标有条目就采用；攥着我们自己挪走的那条就补回；两者都空（那条已被对方清掉，Windows 上实测会撞 ENOENT）就把自己这份发布进去。采用对方条目（正常返回）与收尾异常两条路都走它，绝不出现「返回成功 / 抛出无关错误但键路径是空的」。
4. **真错误带上下文**：非竞争 errno 走 `publishError`，消息形如 `发布条目失败：<tmp> -> <目标>（errno=…，第 N 次）：<原始消息>`，并把 errno 留在 `code` 上；采用对方条目时打 `warn` 一行（`Lab 缓存发布竞争：采用对方已发布的条目`），一次失败就能定位。
5. **`fsyncTree` 的瞬时抖动重试、真错误不吞**：`readdir` 遇 `EBUSY/EAGAIN/EINTR/EMFILE/ENFILE` 小步重试 3 次；用尽或其它 errno 抛 `读目录失败：<path>（errno=…）：<原始消息>`。单个文件/目录的 `fsync` 失败仍然忽略（Windows 不支持目录 fsync；掉电保证少一层不该判分析失败），这一条沿用 r54 的判断。

## 后果

- 发布竞争的失败模式从「抛错（子进程退出 1）」变成「采用对方条目并 warn」，`#85` 的偶发红消失。
- **仍然存在短暂的键路径空窗**：POSIX 不允许把目录原子替换到非空目录上，所以「挪走旧条目 → rename 新条目」之间键路径会短暂不存在。读者（`probeLabEntry`）在这几微秒里按 miss 处理并重算，绝不会读到半截条目。要彻底消掉这个空窗得改成指针/软链间接层，属于另一个设计，不在本 ADR 范围内。
- 竞争下的发布最多慢约 0.8 s（冲突预算）+ 1 s（收尾）+ 0.5 s（最终裁决），Windows 句柄延迟另算 3 s 上限；常态（单进程）无退避、无额外开销。
- 回归测试是**多进程反复抢同一个键**（4 个 writer 子进程，循环同时受「100 次」与「4 s」约束，2 轮；`analysis-cache-race.test.ts`），失败信息里带上子进程落文件的 stderr（含 errno）。实测旧实现：单文件跑通常绿（机器空闲时窗口太窄），把同一个文件 8 路并行跑（`tmp/r66/parallel-file.sh`，等价于 8 路并行全量下的负载）多次观测到 2/8 槽 `ENOTEMPTY` 红、签名与 #85 一致；新实现在同样条件下 8/8 绿。它是概率型护栏，真实稳定性证据来自 8 路并行全量多轮（`tmp/r66/acceptance.sh`）。
- 子进程数量必须克制：8 路并行 × 每槽 8 个 bun 子进程时，实测 bun 进程会在模块解析的 `readdir` 上成片卡住（`sample` 栈落在 `__getdirentries64`，父进程空转等待），用例被拖到 60 s 超时；改成每槽 4 个子进程、把次数堆在迭代里之后既稳定又更便宜（`fsync` 不是瓶颈：单进程 20 次发布只花 19 ms）。
