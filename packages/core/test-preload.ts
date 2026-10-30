/**
 * 测试诊断（r59）：`bun test` 在**同一个进程**里并发跑所有测试文件，任何一个
 * 同步子进程（`execFileSync`/`spawnSync`/`execSync`，底层都是 `Bun.spawnSync`）都会把
 * 整个进程的事件循环冻住——bun 的 5 s 用例超时也是在同一个循环里计时的，于是
 * 「别的文件的昂贵夹具」会让本文件里一条本来 0.2 s 的用例被判超时
 * （r57 实测 `cutClip`、`runNotes > 空 topicIds 拒绝` 各出现一次 5.2 s 触顶，
 * 两条单跑都是毫秒级；本文件实测一次 `notes-run.test.ts` 就有 10 次 1.2–2.6 s 停顿）。
 *
 * 诊断挂在「谁冻住了循环」上，而不是挂在某个具体用例上：
 * - 包一层 `Bun.spawnSync`，慢于 `SLOW_SYNC_MS` 打一行（含 argv 摘要与耗时）；
 * - 事件循环 lag 探针，停顿超过 `LAG_MS` 时连「当时正在跑的同步调用」一起打；
 * - 退出时汇总同步子进程累计阻塞时间与最大停顿。
 *
 * 一次失败就能看出谁把循环冻住了。`VNOTE_TEST_DIAG=0` 关闭；
 * `VNOTE_TEST_DIAG=1` 额外把生产代码的 warn/error 打到 stderr（默认 logger 无 sink，
 * 失败时看不到「为什么这条用例被判成文件损坏」这类内部判定）。
 */
import { configureLogging } from "./src/core/logger";

const SLOW_SYNC_MS = 250;
const LAG_MS = 1000;
const TICK_MS = 100;

if (process.env.VNOTE_TEST_DIAG !== "0") {
  /** 正在执行的同步调用（lag 归因用；同步调用不会嵌套，但保留栈以防将来嵌套）。 */
  const active: string[] = [];
  const slow: { label: string; ms: number }[] = [];
  let syncCalls = 0;
  let syncTotalMs = 0;
  let maxLagMs = 0;

  const origSpawnSync = Bun.spawnSync.bind(Bun);
  Bun.spawnSync = ((first: unknown, options?: unknown) => {
    // node 的 execFileSync 走对象形态 `spawnSync({ cmd: [...] })`，直接调用走数组形态
    const argv: string[] = Array.isArray(first)
      ? (first as string[])
      : first !== null && typeof first === "object" && "cmd" in first && Array.isArray(first.cmd)
        ? (first.cmd as string[])
        : [];
    const label = argv
      .slice(0, 7)
      .map((part) => (part.length > 160 ? `${part.slice(0, 157)}...` : part))
      .join(" ");
    const startedAt = performance.now();
    active.push(label);
    // Bun 的 spawnSync 重载在类型上不接受 unknown，这里原样转发（运行时形状由上面的窄化确认）
    const forward = [first, options] as Parameters<typeof Bun.spawnSync>;
    try {
      return origSpawnSync(...forward);
    } finally {
      active.pop();
      const ms = Math.round(performance.now() - startedAt);
      syncCalls += 1;
      syncTotalMs += ms;
      if (ms >= SLOW_SYNC_MS) {
        slow.push({ label, ms });
        console.error(`[test-diag] 同步子进程阻塞 ${ms} ms：${label}`);
      }
      lastCall = { label, endedAt: performance.now() };
    }
  }) as typeof Bun.spawnSync;

  // VNOTE_TEST_DIAG=1 时把生产代码的 warn/error 打到 stderr：默认 logger 没有 sink，
  // 用例失败时看不到「为什么被判成文件损坏」这类内部判定（r59 的预检误分类就靠它定位）。
  if (process.env.VNOTE_TEST_DIAG === "1") {
    configureLogging({ level: "warn", console: true });
  }

  let last = performance.now();
  /** 最近一次结束的同步调用；探针 tick 被拖慢时用它归因（tick 在调用之后才恢复）。 */
  let lastCall: { label: string; endedAt: number } | null = null;
  const timer = setInterval(() => {
    const now = performance.now();
    const since = last;
    const lag = Math.round(now - last - TICK_MS);
    last = now;
    if (lag <= LAG_MS) return;
    maxLagMs = Math.max(maxLagMs, lag);
    const running =
      active.length > 0
        ? active.join(" ← ")
        : lastCall !== null && lastCall.endedAt >= since
          ? `刚结束的同步子进程 ${lastCall.label}`
          : "（无同步子进程；同步 JS/fs 大活）";
    console.error(`[test-diag] 事件循环停顿 ${lag} ms，期间：${running}`);
  }, TICK_MS);
  // 探针本身不能让测试进程留在原地
  timer.unref();

  process.on("exit", () => {
    if (syncCalls === 0) return;
    const avg = Math.round(syncTotalMs / syncCalls);
    console.error(
      `[test-diag] 汇总：同步子进程 ${syncCalls} 次、累计阻塞 ${Math.round(syncTotalMs)} ms（均值 ${avg} ms）、` +
        `慢调用 ${slow.length} 次、最大停顿 ${maxLagMs} ms`,
    );
  });
}
