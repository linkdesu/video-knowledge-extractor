/**
 * 端口预检（r58 验收 2 / 6）：绝不能连到别的应用或上一轮残留的隧道上。
 *
 * 解析与判定是纯函数；真实 lsof/ps 输出片段来自 10 月 29 日 Mac 上残留的
 * `ssh -N -L 9416:127.0.0.1:9416 gamepc`（PID 62495）。
 */
import { describe, expect, test } from "bun:test";
import { findTunnels, inspectPort, listenerPids, parseLsofPids, parsePsTable, portConflict, tunnelMatches, tunnelsOf } from "./port";

describe("parseLsofPids", () => {
  test("每行一个 pid（lsof -t 的输出）", () => {
    expect(parseLsofPids("62495\n")).toEqual([62495]);
    expect(parseLsofPids("62495\n77001\n")).toEqual([62495, 77001]);
  });

  test("空输出、空白与非数字行不会变出 pid 0", () => {
    expect(parseLsofPids("")).toEqual([]);
    expect(parseLsofPids("\n \n")).toEqual([]);
  });
});

describe("parsePsTable", () => {
  test("pid 与命令行（保留参数里的空格）", () => {
    const table = parsePsTable(
      ["  62495 ssh -N -L 9416:127.0.0.1:9416 gamepc", "  771 ssh -f -N -L 9417:localhost:9417 gamepc", ""].join("\n"),
    );
    expect(table).toEqual([
      { pid: 62495, command: "ssh -N -L 9416:127.0.0.1:9416 gamepc" },
      { pid: 771, command: "ssh -f -N -L 9417:localhost:9417 gamepc" },
    ]);
  });
});

describe("tunnelMatches", () => {
  test("本机端口与远端端口都必须等于 port", () => {
    expect(tunnelMatches("ssh -N -L 9416:127.0.0.1:9416 gamepc", 9416)).toBe(true);
    expect(tunnelMatches("ssh -N -L9416:127.0.0.1:9416 gamepc", 9416)).toBe(true);
    expect(tunnelMatches("ssh -f -N -L 9416:localhost:9416 gamepc", 9416)).toBe(true);
    // 远端端口不同：转发到的是别的服务，不是我们的 CDP
    expect(tunnelMatches("ssh -N -L 9416:127.0.0.1:9417 gamepc", 9416)).toBe(false);
    // 本机端口不同：占用的是另一个端口
    expect(tunnelMatches("ssh -N -L 9417:127.0.0.1:9416 gamepc", 9416)).toBe(false);
    // 前缀相同但端口不同（94161 ≠ 9416）
    expect(tunnelMatches("ssh -N -L 94161:127.0.0.1:94161 gamepc", 9416)).toBe(false);
    // 不是 ssh，或没有 -L
    expect(tunnelMatches("node server.js --port 9416", 9416)).toBe(false);
    expect(tunnelMatches("ssh gamepc tail -f /var/log/x", 9416)).toBe(false);
    expect(tunnelMatches("ssh -N -R 9416:127.0.0.1:9416 gamepc", 9416)).toBe(false);
  });
});

describe("findTunnels", () => {
  test("只留下转发该端口的 ssh", () => {
    const processes = [
      { pid: 62495, command: "ssh -N -L 9416:127.0.0.1:9416 gamepc" },
      { pid: 771, command: "ssh -N -L 9417:127.0.0.1:9417 gamepc" },
      { pid: 900, command: "/Applications/Video Notes.app/Contents/MacOS/Video Notes --remote-debugging-port=9416" },
    ];
    expect(findTunnels(processes, 9416)).toEqual([62495]);
    expect(findTunnels(processes, 9417)).toEqual([771]);
    expect(findTunnels(processes, 9500)).toEqual([]);
  });
});

describe("tunnelsOf", () => {
  test("列出所有 ssh -L 隧道并标出 CDP 形状", () => {
    const found = tunnelsOf([
      { pid: 62495, command: "ssh -N -L 9416:127.0.0.1:9416 gamepc" },
      { pid: 771, command: "ssh -f -N -L9417:localhost:9417 gamepc" },
      { pid: 4242, command: "ssh gamepc tail -f x" },
      { pid: 900, command: "Electron --remote-debugging-port=9416" },
      { pid: 901, command: "ssh -N -L 9418:127.0.0.1:5432 gamepc" },
    ]);
    expect(found.map((entry) => [entry.pid, entry.port, entry.cdpShape])).toEqual([
      [62495, 9416, true],
      [771, 9417, true],
      [901, 9418, false],
    ]);
  });

  test("真实残留（9416 转发到远端 9415）也列出来，但标成非 CDP 形状", () => {
    const found = tunnelsOf([{ pid: 62495, command: "ssh -f -N -L 9416:127.0.0.1:9415 gamepc" }]);
    expect(found).toEqual([{ pid: 62495, port: 9416, cdpShape: false, command: "ssh -f -N -L 9416:127.0.0.1:9415 gamepc" }]);
  });
});

describe("portConflict", () => {
  const listener = (pid: number, command: string) => ({ pid, command });

  test("没人监听：null", () => {
    expect(portConflict({ port: 9416, listeners: [], tunnels: [] })).toBeNull();
  });

  test("只剩上一轮的隧道：可以清掉再启动", () => {
    const conflict = portConflict({
      port: 9416,
      listeners: [listener(62495, "ssh -N -L 9416:127.0.0.1:9416 gamepc")],
      tunnels: [62495],
    });
    expect(conflict).toEqual({ kind: "stale-tunnels", pids: [62495] });
  });

  test("ssh 隧道但不是 harness 形状（9416→远端 9415）：不自动杀，报出来让人确认", () => {
    const conflict = portConflict({
      port: 9416,
      listeners: [listener(62495, "ssh -f -N -L 9416:127.0.0.1:9415 gamepc")],
      tunnels: [],
    });
    expect(conflict).toEqual({
      kind: "foreign-tunnel",
      owners: [{ pid: 62495, command: "ssh -f -N -L 9416:127.0.0.1:9415 gamepc" }],
    });
  });

  test("隧道 + 别的应用：不能只清隧道就开跑，必须报冲突", () => {
    const conflict = portConflict({
      port: 9416,
      listeners: [
        listener(62495, "ssh -N -L 9416:127.0.0.1:9416 gamepc"),
        listener(900, "/Applications/Video Notes.app/Contents/MacOS/Video Notes --remote-debugging-port=9416"),
      ],
      tunnels: [62495],
    });
    expect(conflict?.kind).toBe("occupied");
    if (conflict?.kind !== "occupied") throw new Error("expected occupied");
    expect(conflict.owners.map((owner) => owner.pid)).toEqual([900]);
  });

  test("被普通应用占用：冲突，并带上占用者身份", () => {
    const conflict = portConflict({
      port: 9416,
      listeners: [listener(4242, "node /Volumes/Data/code/video-notes/dev-server.js")],
      tunnels: [],
    });
    expect(conflict?.kind).toBe("occupied");
    if (conflict?.kind !== "occupied") throw new Error("expected occupied");
    expect(conflict.owners).toEqual([{ pid: 4242, command: "node /Volumes/Data/code/video-notes/dev-server.js" }]);
  });
});

describe("inspectPort（注入的 lsof/ps）", () => {
  test("lsof 与 ps 结果合并成占用者身份", () => {
    const state = inspectPort(9416, {
      lsof: () => "62495\n900\n",
      ps: () =>
        "  62495 ssh -N -L 9416:127.0.0.1:9416 gamepc\n  900 /Applications/Video Notes.app/Contents/MacOS/Video Notes --remote-debugging-port=9416\n",
    });
    expect(state.listeners.map((owner) => owner.pid)).toEqual([62495, 900]);
    expect(state.tunnels).toEqual([62495]);
    expect(listenerPids(9416, { lsof: () => "777\n" })).toEqual([777]);
  });

  test("ps 读不到的命令行不丢 pid（用 ps 的原始输出兜底）", () => {
    const state = inspectPort(9416, { lsof: () => "555\n", ps: () => "" });
    expect(state.listeners).toEqual([{ pid: 555, command: "" }]);
  });
});
