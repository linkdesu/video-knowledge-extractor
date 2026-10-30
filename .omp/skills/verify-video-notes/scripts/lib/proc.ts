/**
 * 进程收尾（r58）：启动失败绝不能留下孤儿。
 *
 * 分两步：先 SIGTERM 整棵进程树（Electron 的渲染进程/helper 是子进程，主进程退出
 * 不代表它们退出），宽限期结束后再重读一次进程表——收尾过程中新 fork 出来的子进程
 * 也要收掉——给仍然存活的一律补 SIGKILL。返回 survivors 而不是假装成功，调用方要
 * 能把「杀不掉」报出来。
 *
 * 时间与进程表都可注入：升级判定用虚拟时钟测，真进程只用来验证内核的信号语义。
 */

export type ProcessRow = { pid: number; ppid: number };

export type ProcessDeps = {
  alive: (pid: number) => boolean;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  /** 完整进程表（`ps -Ao pid=,ppid=`），用来找后代与收尾时新冒出来的子进程 */
  tree: () => ProcessRow[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type ProcessStopOptions = {
  /** SIGTERM 后的宽限期（默认 5000ms：Electron 正常退出一秒内结束） */
  termMs?: number;
  /** SIGKILL 后等待真正消失的上限（默认 3000ms） */
  killMs?: number;
  pollMs?: number;
  deps?: ProcessDeps;
};

export type ProcessStopResult = {
  pid: number;
  termSent: number[];
  killSent: number[];
  /** 发过 SIGKILL（SIGTERM 没解决） */
  escalated: boolean;
  /** 收尾结束后仍然活着的 pid（正常情况下为空） */
  survivors: number[];
};

/** 根进程 + 全部后代，父在子前；ppid 成环时只返回环上节点，不死循环。 */
export function treeOf(pid: number, table: ProcessRow[]): number[] {
  const children = new Map<number, number[]>();
  for (const row of table) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const seen = new Set<number>([pid]);
  const ordered = [pid];
  for (let i = 0; i < ordered.length; i += 1) {
    for (const child of children.get(ordered[i]!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      ordered.push(child);
    }
  }
  return ordered;
}

export function processTable(): ProcessRow[] {
  const probe = Bun.spawnSync(["ps", "-Ao", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
  const rows: ProcessRow[] = [];
  for (const line of probe.stdout.toString().split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]) });
  }
  return rows;
}

const realSleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export const realProcessDeps: ProcessDeps = {
  // 僵尸进程（已被 SIGKILL，父进程还没 reaped）不能算「还在运行」：process.kill(pid, 0) 对它返回成功
  alive: (pid) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    const stat = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
    return stat !== "" && !stat.startsWith("Z");
  },
  signal: (pid, signal) => {
    process.kill(pid, signal);
  },
  tree: processTable,
};

export async function stopProcessTree(pid: number, options: ProcessStopOptions = {}): Promise<ProcessStopResult> {
  const deps = options.deps ?? realProcessDeps;
  const termMs = options.termMs ?? 5000;
  const killMs = options.killMs ?? 3000;
  const pollMs = options.pollMs ?? 50;
  const now = deps.now ?? Date.now;
  const nap = deps.sleep ?? realSleep;
  const termSent: number[] = [];
  const killSent: number[] = [];

  const signalAll = (pids: number[], signal: NodeJS.Signals, record: number[]): void => {
    for (const target of pids) {
      try {
        deps.signal(target, signal);
        record.push(target);
      } catch {
        // ESRCH：已经退出
      }
    }
  };
  const living = (pids: number[]): number[] => pids.filter((target) => deps.alive(target));

  const initial = living(treeOf(pid, deps.tree()));
  if (initial.length === 0) return { pid, termSent, killSent, escalated: false, survivors: [] };
  // 父进程先收，避免它在等待期间再拉起 helper；随后是已经在表里的后代
  signalAll(initial, "SIGTERM", termSent);

  const graceDeadline = now() + termMs;
  while (living(initial).length > 0 && now() < graceDeadline) await nap(pollMs);

  // 重读进程表：宽限期里新 fork 的子进程同样不能留
  const stragglers = living(treeOf(pid, deps.tree()));
  if (stragglers.length === 0) return { pid, termSent, killSent, escalated: false, survivors: [] };
  signalAll(stragglers, "SIGKILL", killSent);
  const killDeadline = now() + killMs;
  while (living(stragglers).length > 0 && now() < killDeadline) await nap(pollMs);
  return { pid, termSent, killSent, escalated: true, survivors: living(stragglers) };
}

/** 收尾结果的一行人话（进日志与失败文案）。 */
export function describeStop(result: ProcessStopResult): string {
  const sent = result.termSent.length + result.killSent.length;
  if (sent === 0) return `pid ${result.pid} 已经退出`;
  const parts = [`pid ${result.pid}`];
  if (result.termSent.length > 0) parts.push(`SIGTERM ×${result.termSent.length}`);
  if (result.escalated) parts.push(`SIGKILL ×${result.killSent.length}`);
  if (result.survivors.length > 0) parts.push(`仍在运行：${result.survivors.join(",")}`);
  return parts.join("，");
}
