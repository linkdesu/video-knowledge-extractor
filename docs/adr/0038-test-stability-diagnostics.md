# 测试稳定性：把「偶发红」变成可诊断、可复现

issue #72 的两条偶发红（核心单测偶发 5 s 超时、`notes-run` 的视频锁用例抖动）在 r59 定位到三处互相独立的成因，全部与「同进程共享状态 / 同路径共享文件」有关，与用例逻辑本身无关。

## Status

已接受（accepted，2026-10-31，r59）。

## 决定

### 1. `bun test` 的共享事件循环就是超时计时器 → 测试夹具禁止同步编码

`bun test` 在**一个进程**里按文件顺序跑，bun 的 5 s 用例超时基于该进程的计时器。`execFileSync("ffmpeg", …)` 会把整个循环冻住：`notes-run.test.ts` 每例同步编码一条 340 s 源片（约 1.4 s），15 例就是 20 s 的纯阻塞；机器负载高时单次阻塞可达 6 s（r59 用 6 路并发实测 `事件循环停顿 6141 ms`），落在哪个用例上就报哪个用例超时（r57 记录的是 `cutClip > 纯音频源`、`runNotes > 空 topicIds 拒绝` 两条毫秒级用例 5.2 s 触顶）。

- 源片按「时长 + 容器」在 `beforeAll` 里用**异步** `Bun.spawn` 预生成一次，用例只做 `copyFileSync`（`packages/core/src/pipeline/notes-run.test.ts`）。`notes-run.test.ts` 单文件从 20.3 s 降到 3.9 s，全量 core 从 44 s 降到 24 s。
- `packages/core/test-preload.ts`（由 `packages/core/bunfig.toml` 的 `[test] preload` 注册）给 `Bun.spawnSync` 包一层：单次同步阻塞 ≥250 ms 打一行，事件循环停顿 ≥1 s 打一行并归因到「当时正在跑 / 刚结束的同步子进程」，退出时给累计阻塞汇总。**一次失败就能看出谁冻住了循环**，不再靠反复重跑碰运气。
- `VNOTE_TEST_DIAG=1` 额外把生产代码的 `warn`/`error` 打到 stderr（默认 logger 没有 sink，用例失败时看不到内部判定）。`VNOTE_TEST_DIAG=0` 关闭全部诊断。

### 2. 固定临时路径 = 跨进程互踩；临时文件每次调用唯一

- `notes-run.test.ts` 的 `runTopics` 用例曾用固定 `/tmp/rt-main`：同目录的 `.vnote-run.lock` 让并发的第二次进程拿到「视频正在运行（pid N）」，残留锁还会在 pid 复用后误判。所有夹具目录改为 `mkdtempSync`（每进程唯一），不再用 `Date.now()` 拼名字。
- `extract.ts` 的音轨预检 wav 曾用 `vnote-preflight-${taskId}.wav`（taskId 就是 runToken）：同一 token 的两次运行写同一个文件、并在各自 `finally` 里删掉对方刚写的产物，另一侧把「读不到产物」误判成「音轨无法解码」。改为 `preflightWavPath()`（token + `randomUUID` 片段），`finally` 仍只删自己的文件。
- `endpoint.test.ts` 每个用例 `stop(true)` + 重新 `Bun.serve({ port: 0 })`：端口复用与 keep-alive 连接池会让请求挂住（5 s 超时）或拿到上一个用例的响应。改为整个文件一个 server、端口只绑一次，用例只复位状态。

### 3. 日志的 task id 用 AsyncLocalStorage，不用进程级变量

`runWithTask` 原先把 task id 写在模块级变量里并在 `finally` 里恢复。两次并发任务（同一进程跑两条提取流水线，测试里很常见）会互相覆盖，跑完后还会把 id 漏给后续与本次任务无关的日志（r59 实测让 `logger.test.ts` 的「无 task 行形状」用例偶发红）。改用 `node:async_hooks` 的 `AsyncLocalStorage`，并发任务各带自己的 id，作用域结束即消失。

### 4. 「进程起不来」必须留痕，且不能算被测行为失败（r62 / #79）

`run()` 的 spawn 失败（ENOENT / EAGAIN / ENOMEM 类）以前只 reject、一行日志都不写：诊断文本里对「进程起不来」完全无痕，只断言「命令失败」行的用例会静默落空——`failure-diagnostics.test.ts` 的「坏视频」用例因此偶发红，连带依赖它的聚合用例一起红（#79 的观测签名：同文件两条红、其余绿、耗时 20 ms）。

- **产品侧**：spawn 失败的两条路径（`error` 事件、管道没建成）都写 `ERROR <module> 命令启动失败 cmd=… reason=<errno> …`，抛错消息保持不变。真实用户遇到 ffprobe 起不来时，诊断里能看出是「起不来」而不是「跑失败」。
- **测试侧**：依赖真实子进程的用例用 `attemptSpawn()` 把两种情况分开——spawn 失败重试 3 次（每次让出事件循环并真实短等待：等的是操作系统放行进程创建，假时钟推不动），仍起不来就抛「环境连续 N 次无法启动子进程，不是被测行为」；其它错误（ffprobe 真跑了并失败等）原样交给断言。
- **超时预算**：这类用例显式给 30 s 上限（与本仓库 `notes-run` / `generate-notes` 的真实 ffmpeg 用例一致）。默认 5 s 是共享事件循环上的预算，8 路并行全量时被机器负载吃掉（r62 实测 `5000.00ms` 触顶）；断言不变，卡住仍判失败。

## 后果

- 诊断常开（默认只输出慢项），单次失败自带归因；`VNOTE_TEST_DIAG=0` 可完全静音。
- 夹具生成走异步 spawn：新增夹具时长必须同步加进 `beforeAll` 的 `encodeSource` 列表，否则 `copyFixture` 立即报错（不再静默同步编码）。
- 仍然存在的已知限制：真实 ffmpeg 重活（`cutClip`、主题拼接）在极端负载下可能真的超过默认 5 s，这类用例保留显式 `{ timeout }`，见各测试文件。
- 并发 `runWithTask` 现在安全，但日志写入仍是同步追加，进程级 `configureLogging` 仍是全局单例（测试里跨文件改它会互相影响），属于设计边界。
- 「进程起不来」现在会在日志里出现 `命令启动失败`：诊断的错误摘要会收这一行，QA 拿到的是 errno 与命令名，不再是一句没有上下文的「启动失败」。
