# ADR-0044 子进程执行：Bun 运行时改走 `Bun.spawn`

issue #92（高负载下「坏视频」用例的 ffprobe 偶发 30 s 超时）的根因不在 ffprobe，也不在用例预算，而在 bun 的 `node:child_process` 兼容层：macOS 高负载下，短命子进程的 `exit`/`close` 会在 `spawn()` 返回前就被 emit 掉，监听器永远收不到。`run()` 只等 `close`，于是永不 settle。

## Status

已接受（accepted，2026-11-02，r68）。

## 背景：根因证据

上游 issue oven-sh/bun#45483（open）描述的就是这条路径：`Bun.spawn` 在 fork 后约 1 ms 才注册 kqueue 的 `EVFILT_PROC`；短命子进程此时已被 reap，`ReportUnwatchedExit` 的兜底在 `Bun.spawn()` 返回前跑完 onExit，而 `node:child_process` 的 polyfill 用 `process.nextTick` 调度 `#handleOnExit`，该 nextTick 也在 `spawn()` 栈内执行完毕。结果：

- `exit` / `close` 在 `spawn()` 返回前 emit，之后 `child.once(...)` 永远不触发；
- 两条管道的数据在同一窗口被消费，流已 `readableEnded`，事后读不到任何输出；
- 只影响 `bun test` / bun 运行时（`Bun.spawn` 本身不受影响，上游对照 0/300）。

本机复现（`tmp/verify/r68-ffprobe-timeout/`）：

| 证据 | 修复前 | 修复后 |
|---|---|---|
| 上游最小复现（60 个「一 spawn 一文件」的 `bun test`，8 个 `yes` 负载，6 轮） | 2/6 轮命中，`LOST insideSpawn=[exit,close] exitCodeAfterSpawn=2 stdout="" stderr="" ended=true/true` | — |
| 产品路径 `run()` 复现台（60 文件 × 30 轮，10 个 `yes` 负载，3 s 看门狗） | round 18：2/60 文件 `no-settle`（对应真实用例的 30 s 超时） | 30/30 轮、0/1800 文件不 settle |
| 「坏视频」用例高负载验收（8 并行 × 8 负载 × 20 轮） | — | 20/20 轮全过 |

## 决定

`packages/core/src/core/exec.ts` 的 `run()` 按运行时选择起进程方式：

1. **Bun 运行时**（CLI `#!/usr/bin/env bun`、`bun test`）：用 `Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })`，`await proc.exited` 拿退出码，两条管道用 reader 读到 EOF 并解码。`exited` 是 promise，即使进程在 spawn 期间已退出也已经 resolved；非 lazy 的管道读取由原生侧先 drain，数据不会丢。
2. **Node 运行时**（Electron 主进程）：保持原来的 `node:child_process` 实现不变（Node 没有 #45483 这条路径）。

两条路径只差「怎么起进程」；CRLF 归一、`命令启动失败` / `命令完成` / `命令失败` 日志、错误消息格式、`killActiveChildren`（两个集合都杀）完全共用。

`Bun` 全局不写命名空间类型：core 也被 desktop 的 renderer tsconfig（DOM lib、无 bun types）编译。运行时用 `Reflect.get(globalThis, "Bun")` 取一个只含 `spawn` 的结构类型（`BunRuntime`），Electron 下为 `undefined`。

## 备选方案

- **继续用 `node:child_process`，超时/轮询兜底**：要拿回已丢失的 stderr 只能重跑命令或伪造输出，等于把根因留在原地；轮询也无法恢复已被消费的管道数据。
- **把用例超时从 30 s 加大**：issue 明确禁止；而且事件永远不来，加大预算只会拖慢失败。
- **测试侧 preload 把 `spawn` 换成 `Bun.spawn`**：只修 `bun test`，CLI 在 bun 下仍会卡死；且测试与产品跑不同实现。
- **全部改 `Bun.spawn`**：Electron 主进程没有 `Bun` 全局，不可行。

## 后果

- bun 运行时不再受 #45483 影响；上游修好后本分支仍可保留（`Bun.spawn` 是 Bun 的正式 API）。
- Node 路径的行为零变化，但本仓库单测跑在 bun 下，Node 路径只由 Electron 实际运行覆盖；改动刻意限制在「把原实现原样搬进 `spawnWithNode`」。
- 退出码语义有一处可见差异：被信号杀死时 Node 路径给 `1`（`close` 的 code 为 null），Bun 路径给 `128 + signal`（实测 SIGKILL → 137）。两处都非零，调用方只判断非零。
- `Bun.spawn` 同步抛 ENOENT；`spawnWithBun` 转成与 Node 路径相同的 `"<label> 启动失败: 命令不存在: <file>"` 并写同一条 `命令启动失败` ERROR 行。
