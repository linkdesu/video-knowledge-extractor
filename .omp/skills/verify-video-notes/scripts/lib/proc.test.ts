/**
 * 启动失败收尾（r58）：绝不能留下孤儿进程。
 *
 * 这里的模拟进程表能构造真实内核时序里难复现的两种情形：先忽略 SIGTERM，
 * 以及父进程收到 SIGTERM 之后才 fork 出来的子进程。时间也是注入的虚拟时钟，
 * 所以升级判定的用例不花真实等待。最后一条用真进程验证信号语义。
 */
import { describe, expect, test } from "bun:test";
import { stopProcessTree, treeOf, type ProcessDeps } from "./proc";

type Table = Array<{ pid: number; ppid: number }>;

function simulator(options: {
  tree: Table;
  /** 收到 SIGTERM 后仍然活着 */
  ignoreTerm?: number[];
  /** 连 SIGKILL 也收不掉（只能用来断言 survivors） */
  immortal?: number[];
}) {
  const alive = new Set(options.tree.map((row) => row.pid));
  const signals: Array<{ pid: number; signal: string }> = [];
  const ignoreTerm = new Set(options.ignoreTerm ?? []);
  const immortal = new Set(options.immortal ?? []);
  let tree = options.tree;
  let clock = 0;
  const deps: ProcessDeps = {
    alive: (pid) => alive.has(pid),
    signal: (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === "SIGTERM" && !ignoreTerm.has(pid)) alive.delete(pid);
      if (signal === "SIGKILL" && !immortal.has(pid)) alive.delete(pid);
    },
    tree: () => tree,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return {
    deps,
    signals,
    alive,
    /** 下一次读表时进程表里多出这些行（父进程收尾时才 fork 的情形） */
    addLater: (rows: Table) => {
      tree = [...tree, ...rows];
      for (const row of rows) alive.add(row.pid);
    },
    of: (signal: string) => signals.filter((s) => s.signal === signal).map((s) => s.pid),
  };
}

describe("treeOf", () => {
  test("根进程加上全部后代，父在子前", () => {
    const table: Table = [
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11 },
      { pid: 99, ppid: 1 },
    ];
    expect(treeOf(10, table)).toEqual([10, 11, 12]);
  });

  test("根进程已不在进程表里时仍返回自身（由 alive 决定是否发信号）", () => {
    expect(treeOf(77, [])).toEqual([77]);
  });

  test("环形 ppid 不会死循环", () => {
    const table: Table = [
      { pid: 20, ppid: 21 },
      { pid: 21, ppid: 20 },
    ];
    expect(treeOf(20, table).sort()).toEqual([20, 21]);
  });
});

describe("stopProcessTree", () => {
  test("优雅退出：SIGTERM 后进程消失，不发 SIGKILL", async () => {
    const sim = simulator({ tree: [{ pid: 4001, ppid: 1 }] });
    const result = await stopProcessTree(4001, { termMs: 200, killMs: 200, pollMs: 5, deps: sim.deps });
    expect(result).toMatchObject({ pid: 4001, escalated: false, survivors: [] });
    expect(sim.of("SIGTERM")).toEqual([4001]);
    expect(sim.of("SIGKILL")).toEqual([]);
  });

  test("忽略 SIGTERM 时补 SIGKILL（验收 1 的升级路径）", async () => {
    const sim = simulator({ tree: [{ pid: 4002, ppid: 1 }], ignoreTerm: [4002] });
    const result = await stopProcessTree(4002, { termMs: 80, killMs: 200, pollMs: 5, deps: sim.deps });
    expect(result.escalated).toBe(true);
    expect(result.survivors).toEqual([]);
    expect(sim.of("SIGTERM")).toEqual([4002]);
    expect(sim.of("SIGKILL")).toEqual([4002]);
    expect(sim.alive.has(4002)).toBe(false);
  });

  test("子进程一起收掉：主进程死了不代表渲染进程死了", async () => {
    const sim = simulator({
      tree: [
        { pid: 4003, ppid: 1 },
        { pid: 4004, ppid: 4003 },
      ],
      ignoreTerm: [4004],
    });
    const result = await stopProcessTree(4003, { termMs: 80, killMs: 200, pollMs: 5, deps: sim.deps });
    expect(result.escalated).toBe(true);
    expect(result.survivors).toEqual([]);
    expect(sim.of("SIGKILL")).toEqual([4004]);
  });

  test("收尾过程中新 fork 的子进程也会被清掉（重读进程表）", async () => {
    const sim = simulator({ tree: [{ pid: 4005, ppid: 1 }] });
    let reads = 0;
    const deps: ProcessDeps = {
      ...sim.deps,
      tree: () => {
        reads += 1;
        // 第一次读表之后父进程才 fork 出 helper
        if (reads === 2) sim.addLater([{ pid: 4006, ppid: 4005 }]);
        return reads === 1 ? [{ pid: 4005, ppid: 1 }] : [{ pid: 4005, ppid: 1 }, { pid: 4006, ppid: 4005 }];
      },
    };
    const result = await stopProcessTree(4005, { termMs: 40, killMs: 200, pollMs: 5, deps });
    expect(result.survivors).toEqual([]);
    expect(sim.alive.has(4006)).toBe(false);
  });

  test("主进程先退出、忽略 TERM 的 helper 被 reparent 后仍要 SIGKILL（r58 评审 #1）", async () => {
    // 真实时序：父进程收到 SIGTERM 就退了，macOS 把 helper 的 ppid 改成 1；
    // 再按「以原主 pid 为根」读进程表已经看不到它，必须用初次快照里的后代补刀。
    const alive = new Set([5001, 5002]);
    const signals: Array<{ pid: number; signal: string }> = [];
    let clock = 0;
    let reads = 0;
    const deps: ProcessDeps = {
      alive: (pid) => alive.has(pid),
      signal: (pid, signal) => {
        signals.push({ pid, signal });
        if (pid === 5001 || signal === "SIGKILL") alive.delete(pid);
      },
      tree: () => {
        reads += 1;
        // 第一次：helper 还是 5001 的子进程；之后父进程已退出，ps 里只剩 reparent 后的孤儿
        return reads === 1
          ? [
              { pid: 5001, ppid: 1 },
              { pid: 5002, ppid: 5001 },
            ]
          : [{ pid: 5002, ppid: 1 }];
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    };
    const result = await stopProcessTree(5001, { termMs: 40, killMs: 40, pollMs: 5, deps });
    expect(result.survivors).toEqual([]);
    expect(signals.filter((entry) => entry.signal === "SIGKILL").map((entry) => entry.pid)).toEqual([5002]);
  });

  test("SIGKILL 也收不掉时如实报告 survivors，而不是假装成功", async () => {
    // 既不理 SIGTERM 也扛得住 SIGKILL
    const sim = simulator({ tree: [{ pid: 4007, ppid: 1 }], ignoreTerm: [4007], immortal: [4007] });
    const result = await stopProcessTree(4007, { termMs: 40, killMs: 40, pollMs: 5, deps: sim.deps });
    expect(result.escalated).toBe(true);
    expect(result.survivors).toEqual([4007]);
  });

  test("进程早就没了：一个信号都不发", async () => {
    const sim = simulator({ tree: [] });
    const result = await stopProcessTree(4008, { termMs: 40, killMs: 40, pollMs: 5, deps: sim.deps });
    expect(result).toMatchObject({ pid: 4008, escalated: false, survivors: [] });
    expect(sim.signals).toEqual([]);
  });

  test("信号发送失败（ESRCH）不算错误", async () => {
    const sim = simulator({ tree: [{ pid: 4009, ppid: 1 }] });
    const deps: ProcessDeps = {
      alive: sim.deps.alive,
      tree: sim.deps.tree,
      signal: () => {
        throw new Error("ESRCH");
      },
    };
    const result = await stopProcessTree(4009, { termMs: 30, killMs: 30, pollMs: 5, deps });
    // 进程永远杀不掉：报告 survivor，但不抛异常
    expect(result.survivors).toEqual([4009]);
  });
});

// 真实信号语义只能在真实进程上验证（self-pipe 的 trap 都要内核投递一次信号）。
// `sh` / `ps` / SIGTERM 是 POSIX 的东西：Windows CI 上跳过，mac/linux 上照跑。
describe.skipIf(process.platform === "win32")("stopProcessTree（真进程）", () => {
  test("忽略 SIGTERM 的 sh 被 SIGKILL 掉，结束后没有存活进程", async () => {
    const proc = Bun.spawn(["sh", "-c", 'trap "" TERM; echo ready; sleep 30 & wait'], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    // 等 trap 装好（脚本自己发的事件），不猜时长
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(value)).toContain("ready");

    const result = await stopProcessTree(proc.pid, { termMs: 300, killMs: 3000, pollMs: 20 });
    expect(result.survivors).toEqual([]);
    expect(result.escalated).toBe(true);
    // 父进程（本测试）负责 reap：Bun 的 exited 结算后 ps 里必须查不到这个 pid
    await proc.exited;
    const probe = Bun.spawnSync(["ps", "-p", String(proc.pid), "-o", "pid="]);
    expect(probe.stdout.toString().trim()).toBe("");
  });
});
