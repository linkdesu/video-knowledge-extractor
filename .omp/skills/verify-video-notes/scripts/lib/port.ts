/**
 * 端口预检（r58 验收 2 / 6）。
 *
 * 只问「CDP 有没有应答」是不够的：端口被非 CDP 的应用占着时，`listTargets` 抛错，
 * 旧代码顺手把它当成「端口空闲」，拉起 app 后再连上的其实是别人。这里改成先看
 * 监听者身份：
 *
 * - 没人监听 → 空闲；
 * - 监听者全部是本 harness 自己的 `ssh -N -L <port>:127.0.0.1:<port>` → 上一轮残留的
 *   隧道（清掉再启动），例如 10 月 29 日 mac 上留在 9416 的 PID 62495；
 * - 还有别的进程 → 冲突，报出 pid 与命令行，绝不连接。
 */

export type Listener = { pid: number; command: string };

export type PortState = { port: number; listeners: Listener[]; tunnels: number[] };

export type PortConflict =
  | { kind: "stale-tunnels"; pids: number[] }
  | { kind: "foreign-tunnel"; owners: Listener[] }
  | { kind: "occupied"; owners: Listener[] };

export type PortProbeDeps = { lsof: (port: number) => string; ps: () => string };

/** `lsof -t` 的输出：每行一个 pid。空白与非数字行直接丢掉（不能变出 pid 0）。 */
export function parseLsofPids(output: string): number[] {
  const pids: number[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    pids.push(Number(trimmed));
  }
  return pids;
}

/** `ps -Ao pid=,args=` 的输出：pid 在前，命令行保留内部空格。 */
export function parsePsTable(output: string): Listener[] {
  const rows: Listener[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (match === null) continue;
    rows.push({ pid: Number(match[1]), command: match[2]! });
  }
  return rows;
}

export type TunnelSpec = { localPort: number; remotePort: number };

/** 命令行里所有 `-L <local>:<host>:<remote>` 转发。 */
export function tunnelSpecs(command: string): TunnelSpec[] {
  const tokens = command.split(/\s+/).filter((token) => token !== "");
  const specs: TunnelSpec[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const spec = token === "-L" ? tokens[i + 1] : token.startsWith("-L") ? token.slice(2) : undefined;
    if (spec === undefined) continue;
    const match = /^(\d+):(?:127\.0\.0\.1|localhost):(\d+)$/.exec(spec);
    if (match === null) continue;
    specs.push({ localPort: Number(match[1]), remotePort: Number(match[2]) });
  }
  return specs;
}

/**
 * 这条命令行是不是把 `<port>` 转发到远端的同一个端口（本 harness 的 CDP 隧道）。
 * 本机端口与远端端口都必须等于 port：`-L 9416:127.0.0.1:5432` 是别人的隧道。
 */
export function tunnelMatches(command: string, port: number): boolean {
  return tunnelSpecs(command).some((spec) => spec.localPort === port && spec.remotePort === port);
}

export function findTunnels(processes: Listener[], port: number): number[] {
  return processes.filter((entry) => tunnelMatches(entry.command, port)).map((entry) => entry.pid);
}

/** 命令行第一个词是不是 ssh（`/usr/bin/ssh`、`ssh`、`ssh -f …`）。 */
export function isSshCommand(command: string): boolean {
  const first = command.split(/\s+/)[0] ?? "";
  return first === "ssh" || first.endsWith("/ssh");
}

/**
 * 整张进程表里所有 `ssh -L` 隧道，带上它占用的本机端口。
 * `cdpShape` = 本机端口与远端端口相同，也就是本 harness 自己开的 CDP 隧道。
 */
export function tunnelsOf(processes: Listener[]): Array<Listener & { port: number; cdpShape: boolean }> {
  const found: Array<Listener & { port: number; cdpShape: boolean }> = [];
  for (const entry of processes) {
    if (!isSshCommand(entry.command)) continue;
    const spec = tunnelSpecs(entry.command)[0];
    if (spec === undefined) continue;
    found.push({ pid: entry.pid, command: entry.command, port: spec.localPort, cdpShape: spec.localPort === spec.remotePort });
  }
  return found;
}

export function listenerPids(port: number, deps: Pick<PortProbeDeps, "lsof"> = realPortDeps): number[] {
  return parseLsofPids(deps.lsof(port));
}

export function inspectPort(port: number, deps: PortProbeDeps = realPortDeps): PortState {
  const pids = listenerPids(port, deps);
  const table = new Map(parsePsTable(deps.ps()).map((entry) => [entry.pid, entry.command]));
  const listeners = pids.map((pid) => ({ pid, command: table.get(pid) ?? "" }));
  return { port, listeners, tunnels: findTunnels(listeners, port) };
}

/**
 * 占用判定。列表全是 ssh 隧道时：都是 CDP 形状（本地端口=远端端口）→ 上一轮残留，可以清；
 * 有非 CDP 形状的 ssh 隧道（例如 `-L 9416:127.0.0.1:9415`，就是 10 月 29 日留下的那条）→
 * 不自动杀，报出来由人确认；混进别的进程 → 冲突。
 */
export function portConflict(state: PortState): PortConflict | null {
  if (state.listeners.length === 0) return null;
  const nonTunnels: Listener[] = [];
  let allCdpShape = true;
  for (const entry of state.listeners) {
    const forwards = isSshCommand(entry.command) && tunnelSpecs(entry.command).some((spec) => spec.localPort === state.port);
    if (!forwards) {
      nonTunnels.push(entry);
      continue;
    }
    if (!tunnelMatches(entry.command, state.port)) allCdpShape = false;
  }
  if (nonTunnels.length > 0) return { kind: "occupied", owners: nonTunnels };
  return allCdpShape ? { kind: "stale-tunnels", pids: state.listeners.map((entry) => entry.pid) } : { kind: "foreign-tunnel", owners: state.listeners };
}

/** 整张进程表（`tunnels` 命令用；不依赖端口）。 */
export function processList(deps: Pick<PortProbeDeps, "ps"> = realPortDeps): Listener[] {
  return parsePsTable(deps.ps());
}

export const realPortDeps: PortProbeDeps = {
  lsof: (port) => {
    const probe = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe", stderr: "ignore" });
    return probe.stdout.toString();
  },
  ps: () => {
    const probe = Bun.spawnSync(["ps", "-Ao", "pid=,args="], { stdout: "pipe", stderr: "ignore" });
    return probe.stdout.toString();
  },
};

/** 一句人话的占用者身份（pid + 命令行），进报错与日志。 */
export function describeListeners(listeners: Listener[]): string {
  return listeners.map((entry) => `pid ${entry.pid}${entry.command === "" ? "" : ` (${entry.command})`}`).join("; ");
}
