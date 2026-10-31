/**
 * r60 密钥门禁加固（issue #69）：7 个漏洞的复现测试。
 *
 * 1. 远端历史残留检查（win-gamepc 的 D:\code\video-notes\verify 里 pre-r50 的 user-data）
 * 3. Mac 补二次扫描（应用启动后往证据目录写密钥）
 * 4. 清理逻辑避免误删非目标文件（state.json 里的 runDir 指向证据树之外）
 * 5. 路径解析符号链接（状态根里的 run 目录是链接，指向状态根之外）
 * 6. 读不了的目录不能报「干净」
 * 7. 被拒绝后清理遗留目录（--app 不存在时不留 run 目录与 userData 目录）
 *
 * 漏洞 2（按内容扫描）在 lib/secrets-gate.test.ts：纯逻辑，不需要真进程。
 * 全部是真实进程 + 真实目录；远端用假 `ssh`（只回答门禁需要的那几条命令）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../../..");
const SCRIPT = join(import.meta.dirname, "verify.ts");
const FIXTURES = join(REPO, "tmp/r60-secret-fixtures");
const VERIFY_ROOT = join(REPO, "tmp/verify");
const STATE_ROOT = join(REPO, "tmp/verify-state");
const VICTIM = join(REPO, "tmp/r60-secret-victim");

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path !== undefined) rmSync(path, { recursive: true, force: true });
  }
});

function track(path: string): string {
  cleanup.push(path);
  return path;
}

function alive(pid: number): boolean {
  // 僵尸（已死、父进程还没 reap）不算活着
  const stat = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  return stat !== "" && !stat.startsWith("Z");
}

function run(scriptArgs: string[], opts: { path?: string } = {}): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...scriptArgs], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(opts.path === undefined ? {} : { PATH: `${opts.path}:${process.env.PATH ?? ""}` }), NO_COLOR: "1" },
    timeout: 120000,
  });
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function writeState(runId: string, fields: Record<string, unknown>): string {
  const dir = join(VERIFY_ROOT, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ runId, runDir: dir, port: 1, pid: 999_998, home: join(dir, "home"), userData: join(STATE_ROOT, runId, "user-data"), modelDir: "/tmp/models", appLog: join(dir, "app.log"), electron: "/usr/bin/true", startedAt: new Date().toISOString(), ...fields }, null, 2),
  );
  return dir;
}

/**
 * 假的 ssh：只回答 verify.ts 会问的两类问题（远端 Test-Path 探测、远端密钥清单）。
 * mode 决定远端 staging 根的样子：有历史残留 / 目录不存在 / 读不了。
 */
function writeFakeSsh(mode: "residue" | "missing" | "error" = "residue"): string {
  const bin = track(join(FIXTURES, `fakebin-${mode}`));
  mkdirSync(bin, { recursive: true });
  const ssh = join(bin, "ssh");
  writeFileSync(
    ssh,
    [
      `#!/usr/bin/env bun`,
      `const args = process.argv.slice(2);`,
      `const command = args[args.length - 1] ?? "";`,
      `const mode = ${JSON.stringify(mode)};`,
      `const decode = (cmd) => {`,
      `  const encoded = cmd.match(/-EncodedCommand\\s+(\\S+)/);`,
      `  if (encoded) return Buffer.from(encoded[1], "base64").toString("utf16le");`,
      `  const plain = cmd.match(/-Command\\s+"([\\s\\S]*)"/);`,
      `  return plain ? plain[1] : cmd;`,
      `};`,
      `const script = decode(command);`,
      `if (script.includes("Get-ChildItem")) {`,
      `  if (mode === "error") { process.stderr.write("Get-ChildItem : Access to the path is denied.\\n"); process.exit(1); }`,
      `  if (mode === "missing") { process.stdout.write("MISSING\\n"); } else { process.stdout.write("11\\tD:\\\\code\\\\video-notes\\\\verify\\\\r47\\\\user-data\\\\secrets.bin\\r\\n"); }`,
      `} else if (script.includes("Test-Path")) {`,
      `  process.stdout.write("absent\\n");`,
      `} else {`,
      `  process.stdout.write("ok\\n");`,
      `}`,
      ``,
    ].join("\n"),
  );
  chmodSync(ssh, 0o755);
  return bin;
}

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = server.port ?? 0;
  server.stop(true);
  if (port === 0) throw new Error("could not reserve a free port");
  return port;
}

/**
 * 一个假 app：启动后先把一份密钥写进证据目录（模拟应用把 userData 复制过去），
 * 然后像一个真的 Electron 一样在调试端口上应答 —— 只有「就绪之后」的二次扫描能抓到它。
 */
function writeLeakyApp(): string {
  mkdirSync(FIXTURES, { recursive: true });
  const file = track(join(FIXTURES, "leaky-app.ts"));
  writeFileSync(
    file,
    [
      `#!/usr/bin/env bun`,
      `import { mkdirSync, writeFileSync } from "node:fs";`,
      `import { dirname, join } from "node:path";`,
      `const port = Number((process.argv.find((arg) => arg.startsWith("--remote-debugging-port=")) ?? "").split("=")[1]);`,
      `const home = process.env.VNOTE_HOME ?? "";`,
      `const runDir = dirname(home);`,
      `mkdirSync(join(runDir, "leak"), { recursive: true });`,
      `writeFileSync(join(runDir, "leak", "secrets.bin"), "{}");`,
      `Bun.serve({`,
      `  port,`,
      `  hostname: "127.0.0.1",`,
      `  fetch(req, server) {`,
      `    if ((req.headers.get("upgrade") ?? "") !== "") {`,
      `      if (server.upgrade(req)) return undefined;`,
      `      return new Response("no upgrade", { status: 400 });`,
      `    }`,
      `    if (new URL(req.url).pathname === "/json") {`,
      `      return Response.json([{ type: "page", url: "vnote-app://index/index.html", title: "fake", webSocketDebuggerUrl: \`ws://127.0.0.1:\${port}/devtools/page/FAKE\` }]);`,
      `    }`,
      `    return new Response("not found", { status: 404 });`,
      `  },`,
      `  websocket: {`,
      `    message(ws, data) {`,
      `      const msg = JSON.parse(String(data));`,
      `      ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { ready: true, readyState: "complete", navLibrary: true, notesRoot: home } } } }));`,
      `    },`,
      `  },`,
      `});`,
      ``,
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return file;
}

describe.skipIf(process.platform !== "darwin")("r60 密钥门禁（issue #69）", () => {
  test("漏洞 1：远端历史残留——up --target win-gamepc 在创建任何东西之前报错", { timeout: 60_000 }, () => {
    const bin = writeFakeSsh();
    const runId = "r60-test-remote-residue";
    for (const path of [join(VERIFY_ROOT, runId), join(STATE_ROOT, runId)]) {
      rmSync(path, { recursive: true, force: true });
      track(path);
    }
    const result = run(["up", "--target", "win-gamepc", "--run", runId, "--port", String(freePort())], { path: bin });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("远端");
    expect(result.stderr).toContain("D:\\code\\video-notes\\verify\\r47\\user-data\\secrets.bin");
    // 远端残留不该等到建目录、传 app 之后才发现
    expect(existsSync(join(VERIFY_ROOT, runId))).toBe(false);
    expect(existsSync(join(STATE_ROOT, runId))).toBe(false);
  });

  test("漏洞 1b：远端目录不存在不算残留，读不了才失败", { timeout: 60_000 }, () => {
    const runId = "r60-test-remote-unreadable";
    for (const path of [join(VERIFY_ROOT, runId), join(STATE_ROOT, runId)]) {
      rmSync(path, { recursive: true, force: true });
      track(path);
    }
    // 新机器：远端还没有 verify 目录 -> 门禁放行（后面会在私有配置上失败，与门禁无关）
    const fresh = run(["up", "--target", "win-gamepc", "--run", runId, "--port", String(freePort())], { path: writeFakeSsh("missing") });
    expect(fresh.code).toBe(1);
    expect(fresh.stderr).not.toContain("远端证据目录");

    // 读不了（Get-ChildItem 报错 / ssh 退出非零）-> 失败，绝不报干净
    const secondId = `${runId}-2`;
    track(join(VERIFY_ROOT, secondId));
    const unreadable = run(["up", "--target", "win-gamepc", "--run", secondId, "--port", String(freePort())], { path: writeFakeSsh("error") });
    expect(unreadable.code).toBe(1);
    expect(unreadable.stderr).toContain("无法读取远端证据目录");
  });

  test("漏洞 3：Mac 就绪后二次扫描——应用把密钥写进证据目录，up 失败并收掉进程", { timeout: 90_000 }, () => {
    const app = writeLeakyApp();
    const runId = "r60-test-mac-second-scan";
    for (const path of [join(VERIFY_ROOT, runId), join(STATE_ROOT, runId)]) {
      rmSync(path, { recursive: true, force: true });
      track(path);
    }
    const result = run(["up", "--run", runId, "--port", String(freePort()), "--app", app, "--empty-settings", "--ready-timeout", "20000"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("密钥文件");
    expect(result.stderr).toContain(join(runId, "leak", "secrets.bin"));
    // 收尾：起来的假 app 不能留成孤儿
    const state = JSON.parse(readFileSync(join(VERIFY_ROOT, runId, "state.json"), "utf8")) as { pid: number };
    expect(alive(state.pid)).toBe(false);
  });

  test("漏洞 4：down --purge 不删 state.json 指向证据树之外的东西", { timeout: 30_000 }, () => {
    const victim = track(VICTIM);
    rmSync(victim, { recursive: true, force: true });
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "keep.txt"), "important\n");
    const runId = "r60-test-purge-outside";
    rmSync(join(VERIFY_ROOT, runId), { recursive: true, force: true });
    track(join(VERIFY_ROOT, runId));
    writeState(runId, { runDir: victim });

    const result = run(["down", "--run", runId, "--purge"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("拒绝");
    expect(existsSync(join(victim, "keep.txt"))).toBe(true);
    // 连 state.json 都不该往证据树外写
    expect(existsSync(join(victim, "state.json"))).toBe(false);
  });

  test("漏洞 5：状态根里的 run 目录是符号链接时，down --purge 不跟随、不删链接目标", { timeout: 30_000 }, () => {
    const victim = track(join(VICTIM, "symlink-target"));
    rmSync(victim, { recursive: true, force: true });
    mkdirSync(join(victim, "user-data", "Cache"), { recursive: true });
    writeFileSync(join(victim, "user-data", "Cache", "keep.bin"), "important\n");
    const runId = "r60-test-purge-symlink";
    const stateDir = join(STATE_ROOT, runId);
    rmSync(stateDir, { recursive: true, force: true });
    track(stateDir);
    mkdirSync(STATE_ROOT, { recursive: true });
    symlinkSync(victim, stateDir);
    rmSync(join(VERIFY_ROOT, runId), { recursive: true, force: true });
    const runDir = track(join(VERIFY_ROOT, runId));
    writeState(runId, { userData: join(stateDir, "user-data") });

    const result = run(["down", "--run", runId, "--purge"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("拒绝");
    expect(existsSync(join(victim, "user-data", "Cache", "keep.bin"))).toBe(true);
    // 早期就拒绝：证据目录也还在（没有删掉一半再报错）
    expect(existsSync(runDir)).toBe(true);
  });

  test("漏洞 6：读不了的证据目录让 secrets-gate 失败，而不是报 clean", { timeout: 30_000 }, () => {
    const runId = "r60-test-unreadable";
    const runDir = track(join(VERIFY_ROOT, runId));
    rmSync(runDir, { recursive: true, force: true });
    const locked = join(runDir, "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "app.log"), "nothing secret\n");
    chmodSync(locked, 0o000);
    try {
      const result = run(["secrets-gate"]);
      expect(result.code).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain(locked);
      expect(output).toContain("无法读取");
      // 成功行是 `secrets-gate: clean (<root>)`；不能用裸 "clean"，worktree 路径本身可能含 clean
      expect(output).not.toContain("secrets-gate: clean");
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("漏洞 7：up 被拒（--app 不存在）后不留本次创建的目录", { timeout: 30_000 }, () => {
    const runId = "r60-test-rejected-cleanup";
    for (const path of [join(VERIFY_ROOT, runId), join(STATE_ROOT, runId)]) {
      rmSync(path, { recursive: true, force: true });
      track(path);
    }
    const result = run(["up", "--run", runId, "--port", String(freePort()), "--app", join(FIXTURES, "does-not-exist.app"), "--no-build"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("app not found");
    expect(existsSync(join(VERIFY_ROOT, runId))).toBe(false);
    expect(existsSync(join(STATE_ROOT, runId))).toBe(false);
  });
});
