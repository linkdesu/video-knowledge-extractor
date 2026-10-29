/**
 * 打包版首启渲染门禁（r49）。
 *
 * 为什么单独一个脚本：`verify.ts up` 驱动的是构建产物或指定 `.app`，但它每次都会
 * 复用 run 目录里的 userData，也从不判断「首屏是不是白屏」。r48 发布后安装版在
 * mac/Windows 上都出现白屏（renderer 文档 readyState 常驻 loading），而 dev 模式
 * 完全正常。这条门禁专门复现用户动作：拿打包好的应用，用**全新 userData** 连续冷
 * 启动 N 次，每次断言主界面真的渲染出来（截图 + DOM 断言），任一次白屏即失败。
 *
 * userData 落在 `tmp/verify-state/`（证据目录之外），因此证据目录里不会出现
 * settings.json / secrets.bin 之类的用户数据。
 *
 * 用法：
 *   bun .omp/skills/verify-video-notes/scripts/packaged-launch.ts
 *   bun ... packaged-launch.ts --app "apps/desktop/release/Video Notes-darwin-arm64/Video Notes.app"
 *   bun ... packaged-launch.ts --runs 5 --run pkglaunch-0.1.9
 *   bun ... packaged-launch.ts --target win-gamepc --app "D:\code\video-notes\app\Video Notes.exe"
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Cdp, listTargets, writeAxTree } from "./lib/cdp";
import { defaultModelDir } from "./lib/model-dir";

const REPO = resolve(import.meta.dirname, "../../../..");
const DESKTOP = join(REPO, "apps/desktop");
const EVIDENCE_ROOT = join(REPO, "tmp/verify");
/** 证据目录之外：这里放 userData（含 secrets.bin），永远不进 tmp/verify/<run>/。 */
const STATE_ROOT = join(REPO, "tmp/verify-state");
const HELP = `usage: packaged-launch.ts [--app PATH] [--runs N] [--run ID] [--port N] [--timeout MS]
                          [--target mac|win-gamepc] [--ssh-host NAME]

  --app PATH       打包产物：mac 的 .app 目录（默认 /Applications/Video Notes.app）或可执行文件；
                   win-gamepc 上是远端 exe 路径（默认 D:\\code\\video-notes\\app\\Video Notes.exe）。
  --runs N         冷启动次数（默认 3）；每次都用一份全新 userData。
  --run ID         证据目录名（默认 pkglaunch-<时间戳>）。
  --port N         CDP 端口（默认 9481）。
  --timeout MS     每次启动等待主界面渲染的上限（默认 25000）。
  --target         mac（默认）或 win-gamepc；win 侧复用 verify.ts 的安装/启动/隧道机制。
`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}

function takeFlag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) {
    process.stderr.write(`packaged-launch: ${name} 需要一个值\n`);
    process.exit(1);
  }
  args.splice(i, 2);
  return value;
}

const targetFlag = takeFlag("--target") ?? "mac";
if (targetFlag !== "mac" && targetFlag !== "win-gamepc") {
  process.stderr.write(`packaged-launch: 未知 --target ${targetFlag}\n`);
  process.exit(1);
}
const target = targetFlag;
const runs = Number(takeFlag("--runs") ?? "3");
const port = Number(takeFlag("--port") ?? "9481");
const timeoutMs = Number(takeFlag("--timeout") ?? "25000");
const sshHost = takeFlag("--ssh-host") ?? "gamepc";
const appFlag = takeFlag("--app");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const runId = takeFlag("--run") ?? `pkglaunch-${stamp}`;
if (args.length > 0) {
  process.stderr.write(`packaged-launch: 未知参数 ${args.join(" ")}\n`);
  process.exit(1);
}

const evidenceDir = join(EVIDENCE_ROOT, runId);
const stateDir = join(STATE_ROOT, runId);

function desktopVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || typeof parsed.version !== "string") {
    throw new Error("apps/desktop/package.json 缺少字符串 version");
  }
  return parsed.version;
}

/** A .app bundle runs its CFBundleExecutable; a plain path runs as-is. */
function bundleExecutable(appPath: string): string {
  if (!existsSync(appPath)) throw new Error(`应用不存在：${appPath}`);
  if (!appPath.endsWith(".app")) return appPath;
  const plist = join(appPath, "Contents/Info.plist");
  const name = Bun.spawnSync(["plutil", "-extract", "CFBundleExecutable", "raw", "-o", "-", plist]).stdout.toString().trim();
  if (name === "") throw new Error(`读不到 CFBundleExecutable：${plist}`);
  const exe = join(appPath, "Contents/MacOS", name);
  if (!existsSync(exe)) throw new Error(`bundle 可执行文件缺失：${exe}`);
  return exe;
}

function appVersionOf(appPath: string): string {
  if (!appPath.endsWith(".app")) return "unknown";
  const plist = join(appPath, "Contents/Info.plist");
  return Bun.spawnSync(["plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist]).stdout.toString().trim();
}

type LaunchFacts = {
  readyState: string;
  rootChildren: number;
  rootText: string;
  navLibrary: boolean;
  navCount: number;
  settingsVersion: string | null;
  title: string;
  bodyLength: number;
};

const FACTS_EXPRESSION = `(async () => {
  const root = document.getElementById("root");
  const settings = window.vnote === undefined ? null : await window.vnote.settings().catch(() => null);
  return {
    readyState: document.readyState,
    rootChildren: root === null ? 0 : root.childElementCount,
    rootText: root === null ? "" : (root.innerText || "").slice(0, 200),
    navLibrary: document.querySelector('[data-testid=nav-library]') !== null,
    navCount: document.querySelectorAll('nav [data-testid^="nav-"]').length,
    settingsVersion: settings === null ? null : settings.appVersion,
    title: document.title,
    bodyLength: document.body === null ? 0 : document.body.innerHTML.length,
  };
})()`;

/** 等 CDP target 出现：个别启动里渲染进程晚几百毫秒才建 page。 */
async function waitForPort(deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port);
      if (targets.some((t) => t.type === "page")) return;
    } catch {
      // 端口还没起，继续等
    }
    await Bun.sleep(150);
  }
  throw new Error(`CDP 端口 ${port} 在 ${timeoutMs}ms 内没有出现 page target`);
}

/** 白屏的判定标准就是这三条：文档没完成、root 空、没有主界面导航。 */
function verdict(facts: LaunchFacts, expectedVersion: string): string[] {
  const problems: string[] = [];
  if (facts.readyState !== "complete") problems.push(`readyState=${facts.readyState}`);
  if (facts.rootChildren === 0) problems.push("root 无子节点");
  if (!facts.navLibrary) problems.push("缺少 [data-testid=nav-library]");
  if (facts.settingsVersion !== expectedVersion) problems.push(`appVersion=${String(facts.settingsVersion)}，期望 ${expectedVersion}`);
  return problems;
}

async function launchMac(appPath: string, index: number, expectedVersion: string): Promise<{ ok: boolean; problems: string[]; facts: LaunchFacts | null }> {
  const launchDir = join(stateDir, `launch-${index}`);
  rmSync(launchDir, { recursive: true, force: true });
  mkdirSync(launchDir, { recursive: true });
  const userData = join(launchDir, "user-data");
  const home = join(launchDir, "home");
  mkdirSync(userData, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VNOTE_LLM_") || key.startsWith("IDEALSOFT_")) delete env[key];
  }
  env.VNOTE_HOME = home;
  env.VNOTE_USER_DATA = userData;
  env.VNOTE_MODEL_DIR ??= defaultModelDir(process.env.HOME ?? "/Users/link");
  const proc = Bun.spawn([bundleExecutable(appPath), `--remote-debugging-port=${port}`], {
    env,
    cwd: REPO,
    stdin: "ignore",
    stdout: Bun.file(join(launchDir, "stdout.log")),
    stderr: Bun.file(join(launchDir, "stderr.log")),
  });
  let facts: LaunchFacts | null = null;
  let problems: string[] = [];
  try {
    await waitForPort(Date.now() + timeoutMs);
    const cdp = await Cdp.open(port);
    try {
      await cdp.send("Runtime.enable");
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const current = await cdp.eval<LaunchFacts>(FACTS_EXPRESSION).catch(() => null);
        if (current !== null) {
          facts = current;
          if (current.readyState === "complete" && current.navLibrary) break;
        }
        await Bun.sleep(200);
      }
      const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(evidenceDir, `launch-${index}.png`), Buffer.from(shot.data, "base64"));
      await writeAxTree(cdp, join(evidenceDir, `launch-${index}.aria.txt`));
    } finally {
      cdp.close();
    }
    problems = facts === null ? ["CDP 求值全部失败"] : verdict(facts, expectedVersion);
  } catch (err) {
    problems = [err instanceof Error ? err.message : String(err)];
  } finally {
    proc.kill();
    await proc.exited;
    // 进程必须真的退出，否则下一次冷启动会抢单实例锁
    await Bun.sleep(300);
  }
  return { ok: problems.length === 0, problems, facts };
}

/** Windows 侧没有本地打包产物可跑：交给 verify.ts 的安装/计划任务/隧道机制。 */
async function launchWin(appPath: string, index: number, expectedVersion: string): Promise<{ ok: boolean; problems: string[]; facts: LaunchFacts | null }> {
  const run = `${runId}-win-${index}`;
  const verifyScript = join(REPO, ".omp/skills/verify-video-notes/scripts/verify.ts");
  const up = Bun.spawnSync(
    ["bun", verifyScript, "up", "--target", "win-gamepc", "--ssh-host", sshHost, "--app", appPath, "--run", run, "--empty-settings", "--port", String(port)],
    { cwd: REPO, stdout: "pipe", stderr: "pipe" },
  );
  writeFileSync(join(evidenceDir, `launch-${index}.up.log`), `${up.stdout.toString()}${up.stderr.toString()}`);
  if (up.exitCode !== 0) {
    return { ok: false, problems: [`verify.ts up 失败（退出码 ${up.exitCode}）`], facts: null };
  }
  const evalResult = Bun.spawnSync(["bun", verifyScript, "drive", "eval", FACTS_EXPRESSION, "--run", run], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["bun", verifyScript, "drive", "shot", `launch-${index}`, "--run", run], { cwd: REPO });
  Bun.spawnSync(["bun", verifyScript, "down", "--run", run, "--target", "win-gamepc"], { cwd: REPO });
  let facts: LaunchFacts | null = null;
  try {
    facts = JSON.parse(evalResult.stdout.toString()) as LaunchFacts;
  } catch {
    facts = null;
  }
  const problems = facts === null ? [`drive eval 失败：${evalResult.stderr.toString().slice(0, 400)}`] : verdict(facts, expectedVersion);
  return { ok: problems.length === 0, problems, facts };
}

const expectedVersion = desktopVersion();
const appPath = appFlag ?? (target === "win-gamepc" ? "D:\\code\\video-notes\\app\\Video Notes.exe" : "/Applications/Video Notes.app");
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });

process.stdout.write(
  `packaged-launch: target=${target} app=${appPath} runs=${runs} evidence=${evidenceDir}\n` +
    `packaged-launch: userData 在证据目录之外 -> ${stateDir}\n`,
);

type RunResult = { index: number; ok: boolean; problems: string[]; facts: LaunchFacts | null };
const results: RunResult[] = [];
for (let index = 1; index <= runs; index++) {
  const result = target === "win-gamepc" ? await launchWin(appPath, index, expectedVersion) : await launchMac(appPath, index, expectedVersion);
  results.push({ index, ...result });
  writeFileSync(join(evidenceDir, `launch-${index}.json`), `${JSON.stringify({ target, appPath, expectedVersion, ...result }, null, 2)}\n`);
  process.stdout.write(`  launch ${index}: ${result.ok ? "OK" : `FAIL ${result.problems.join("; ")}`}\n`);
  // 每次启动都换端口会拖慢排障；同一端口顺序复用，只要上一个进程真的退出了。
  if (target === "win-gamepc") await Bun.sleep(500);
}

const failed = results.filter((r) => !r.ok);
writeFileSync(
  join(evidenceDir, "summary.json"),
  `${JSON.stringify(
    {
      target,
      appPath,
      installedVersion: target === "mac" ? appVersionOf(appPath) : null,
      expectedVersion,
      runs,
      startedAt: new Date().toISOString(),
      results,
    },
    null,
    2,
  )}\n`,
);

if (failed.length > 0) {
  process.stderr.write(`packaged-launch: ${failed.length}/${runs} 次冷启动没有渲染主界面（白屏/版本不符）\n`);
  process.exit(1);
}
process.stdout.write(`packaged-launch: ${runs}/${runs} 次冷启动都渲染了主界面，证据在 ${evidenceDir}\n`);
