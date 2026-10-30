/**
 * 启动门禁的稳健性（r58 验收 1 / 2 / 6）。全部用真实进程与真实端口：
 *
 * 1. 端口被别的应用占着 → `up` 立刻报冲突（带占用者 pid 与命令行），不拉起 Electron；
 * 2. 上一轮残留的 CDP 隧道占着端口 → `up` 认出并清掉它，而不是连上去；
 * 3. 应用永远不就绪、而且不理 SIGTERM → `up` 收尾补 SIGKILL，结束后没有孤儿进程。
 *
 * `--app` 指向一个假 app，所以不需要 build，也不需要真的 Electron。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../../..");
const SCRIPT = join(import.meta.dirname, "verify.ts");
const FIXTURES = join(REPO, "tmp/r58-hardening-fixtures");
const VERIFY_ROOT = join(REPO, "tmp/verify");
const STATE_ROOT = join(REPO, "tmp/verify-state");

type Spawned = { pid: number; stop: () => void };

/** 等夹具自己报告已绑定端口（不猜时长：listen 之后它才写第一行）。 */
async function awaitListening(proc: { stdout: ReadableStream<Uint8Array> }): Promise<string> {
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return new TextDecoder().decode(value ?? new Uint8Array());
}

/** 一个只监听、不说 CDP 的「别的应用」。 */
async function startOtherApp(port: number): Promise<Spawned> {
  const file = join(FIXTURES, "other-app.js");
  const proc = Bun.spawn(["bun", file, String(port)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const banner = await awaitListening(proc);
  if (!banner.includes(`listening ${port}`)) throw new Error(`fixture did not bind ${port}: ${banner}`);
  return { pid: proc.pid, stop: () => proc.kill() };
}

/** 形状与 10 月 29 日残留的 `ssh -N -L 9416:127.0.0.1:9416 gamepc` 一致（argv[0] 伪装，不依赖 sshd）。 */
async function startStaleTunnel(port: number): Promise<Spawned> {
  const file = join(FIXTURES, "other-app.js");
  const proc = Bun.spawn(["bash", "-c", `exec -a "ssh -N -L ${port}:127.0.0.1:${port} gamepc" bun ${file} ${port}`], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const banner = await awaitListening(proc);
  if (!banner.includes(`listening ${port}`)) throw new Error(`fixture did not bind ${port}: ${banner}`);
  return { pid: proc.pid, stop: () => proc.kill() };
}

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = server.port ?? 0;
  server.stop(true);
  if (port === 0) throw new Error("could not reserve a free port");
  return port;
}

function writeFixtures(): void {
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(
    join(FIXTURES, "other-app.js"),
    [
      `const port = Number(process.argv[2]);`,
      `Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("not our app") });`,
      `process.stdout.write("listening " + port + "\\n");`,
      ``,
    ].join("\n"),
  );
  // 永远不出 CDP、而且不理 SIGTERM：只有 SIGKILL 能收掉它
  writeFileSync(join(FIXTURES, "stubborn-app.sh"), ["#!/bin/sh", "trap '' TERM", `echo "stubborn $$"`, "while true; do sleep 1; done", ""].join("\n"));
  Bun.spawnSync(["chmod", "+x", join(FIXTURES, "stubborn-app.sh")]);
}

function runUp(args: string[]): { code: number; stderr: string; ms: number } {
  const started = Date.now();
  const proc = Bun.spawnSync(["bun", SCRIPT, "up", ...args], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 120000,
  });
  return { code: proc.exitCode ?? -1, stderr: proc.stderr.toString(), ms: Date.now() - started };
}

function cleanupRun(runId: string): void {
  rmSync(join(VERIFY_ROOT, runId), { recursive: true, force: true });
  rmSync(join(STATE_ROOT, runId), { recursive: true, force: true });
}

function pidAlive(pid: number): boolean {
  // 僵尸（已死、父进程还没 reap）不算活着：process.kill(pid, 0) 对它返回成功
  const stat = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  return stat !== "" && !stat.startsWith("Z");
}

const started: Spawned[] = [];
afterEach(() => {
  while (started.length > 0) started.pop()?.stop();
});

/** 写一份只记录隧道/进程的 state.json（预检只读 sshTunnelPid / runId / stoppedAt）。 */
function writeRunState(runId: string, fields: Record<string, unknown>): void {
  const dir = join(VERIFY_ROOT, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ runId, runDir: dir, ...fields }, null, 2));
}

// verify.ts 的 mac 目标本身就只跑在 darwin（lsof / plutil / launchd PATH / bundle 布局），
// 这里的假 app 也用 sh 的 trap。Windows 的 CI 只跑单元测试，不跑这套真实进程门禁。
describe.skipIf(process.platform !== "darwin")("up 的启动门禁（r58）", () => {
  test("端口被别的应用占用：立刻报冲突，绝不拉起 Electron 去抢端口", { timeout: 60_000 }, async () => {
    writeFixtures();
    const port = freePort();
    const other = await startOtherApp(port);
    started.push(other);
    const runId = "r58-test-port-busy";
    cleanupRun(runId);

    // 也指向假 app：本用例只关心端口预检，不走 Electron 查找
    const result = runUp([
      "--run",
      runId,
      "--port",
      String(port),
      "--app",
      join(FIXTURES, "stubborn-app.sh"),
      "--ready-timeout",
      "1500",
      "--empty-settings",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("端口被占用");
    expect(result.stderr).toContain(String(other.pid));
    // 预检在拉起 app 之前：不会留下 state.json，也不会等满 CDP 超时
    expect(existsSync(join(VERIFY_ROOT, runId, "state.json"))).toBe(false);
    expect(result.ms).toBeLessThan(15000);
  });

  test("上一轮残留的隧道（无 run 记录、对端无应答）：认出并清掉，而不是连到它", { timeout: 60_000 }, async () => {
    writeFixtures();
    const port = freePort();
    const stale = await startStaleTunnel(port);
    started.push(stale);
    const runId = "r58-test-stale-tunnel";
    cleanupRun(runId);

    // 假 app 不会说话，所以 up 一定失败；这里只断言它先认出并清掉了残留隧道
    const result = runUp([
      "--run",
      runId,
      "--port",
      String(port),
      "--app",
      join(FIXTURES, "stubborn-app.sh"),
      "--ready-timeout",
      "1500",
      "--empty-settings",
    ]);
    expect(result.stderr).toContain("残留隧道");
    expect(result.stderr).toContain(String(stale.pid));
    expect(pidAlive(stale.pid)).toBe(false);
  });

  test("有活跃 run 记录的隧道：报冲突但绝不杀掉它", { timeout: 60_000 }, async () => {
    writeFixtures();
    const port = freePort();
    const live = await startStaleTunnel(port);
    started.push(live);
    const ownerRun = "r58-test-tunnel-owner";
    cleanupRun(ownerRun);
    writeRunState(ownerRun, { port, pid: 1, sshTunnelPid: live.pid, target: "win-gamepc", home: "C:\\x", userData: "C:\\y", modelDir: "C:\\z", appLog: "x" });
    const runId = "r58-test-tunnel-owned";
    cleanupRun(runId);
    try {
      const result = runUp([
        "--run",
        runId,
        "--port",
        String(port),
        "--app",
        join(FIXTURES, "stubborn-app.sh"),
        "--ready-timeout",
        "1500",
        "--empty-settings",
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("还在用这个端口");
      expect(result.stderr).toContain(ownerRun);
      // 别人的活跃隧道不能动
      expect(pidAlive(live.pid)).toBe(true);
    } finally {
      cleanupRun(ownerRun);
    }
  });

  test("应用永远不就绪且不理 SIGTERM：超时报错清楚，结束后没有孤儿进程", { timeout: 60_000 }, async () => {
    writeFixtures();
    const port = freePort();
    const runId = "r58-test-orphan";
    cleanupRun(runId);

    const result = runUp([
      "--run",
      runId,
      "--port",
      String(port),
      "--app",
      join(FIXTURES, "stubborn-app.sh"),
      "--ready-timeout",
      "1500",
      "--empty-settings",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("没有就绪");
    expect(result.stderr).toContain("SIGKILL");
    // state.json 在收尾前写盘：pid 是 up 自己拉起的那个顽固进程
    const state = JSON.parse(readFileSync(join(VERIFY_ROOT, runId, "state.json"), "utf8")) as { pid: number };
    expect(pidAlive(state.pid)).toBe(false);
    // 证据保留（失败现场要能复盘），但实例不再占端口
    expect(existsSync(join(VERIFY_ROOT, runId, "app.log"))).toBe(true);
  });
});

// 下面三条与平台无关（都在启动前的参数/编号校验上失败，不需要 lsof 或 Electron）。
describe("参数与运行编号门禁（r58）", () => {
  test("未知参数直接报错，且不创建 run 目录", () => {
    const runId = "r58-test-unknown-arg";
    cleanupRun(runId);
    const proc = Bun.spawnSync(["bun", SCRIPT, "up", "--run", runId, "--prot", "9412", "--no-build"], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("未知参数");
    expect(existsSync(join(VERIFY_ROOT, runId))).toBe(false);
  });

  test("`up --help` 只打印用法，不启动任何 run", () => {
    const proc = Bun.spawnSync(["bun", SCRIPT, "up", "--help"], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("usage: verify.ts");
    expect(proc.stdout.toString()).toContain("--ready-timeout");
  });

  test("state.json 的 runId 与目录名不一致：doctor 直接拒绝", () => {
    const runId = "r58-test-runid-mismatch";
    cleanupRun(runId);
    writeRunState(runId, { runId: "r58-some-other-run", port: 1, pid: 1 });
    try {
      const proc = Bun.spawnSync(["bun", SCRIPT, "doctor", "--run", runId], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toContain("运行编号不一致");
    } finally {
      cleanupRun(runId);
    }
  });
});
