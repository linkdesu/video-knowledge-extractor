#!/usr/bin/env bun
/**
 * verify-video-notes control helper.
 *
 * Starts an isolated Electron instance of apps/desktop, drives it over CDP with real
 * mouse/keyboard/drag input, and keeps every proof artifact under tmp/verify/<run>/.
 *
 *   bun .omp/skills/verify-video-notes/scripts/verify.ts up
 *   bun .omp/skills/verify-video-notes/scripts/verify.ts doctor
 *   bun .omp/skills/verify-video-notes/scripts/verify.ts drive click '[data-testid=nav-glossary]'
 *   bun .omp/skills/verify-video-notes/scripts/verify.ts down
 *
 * Run with `--help` for the full command list.
 */
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Cdp, listTargets, writeAxTree } from "./lib/cdp";
import { ensureElectronBinary, ElectronBootstrapError, type ElectronBootstrapResult } from "./lib/electron";
import { describeGap, evidenceGaps, evidenceInventory, parseRemoteListing, relativeEvidencePath } from "./lib/evidence";
import { latestPointerProblem, readLatestPointer, writeLatestPointer } from "./lib/latest";
import { describeListeners, inspectPort, portConflict, processList, tunnelsOf } from "./lib/port";
import { describeStop, stopProcessTree } from "./lib/proc";
import { findSecretFiles, isInside, winPathInside } from "./lib/secrets-gate";
import { classifyFindings, dedupeFindings, parseFindings, resolveImpeccableBin, runImpeccable, type ImpeccableFinding } from "./lib/impeccable";
import { jobPaddingProblems, viewportProblems } from "./lib/layout";
import { defaultModelDir } from "./lib/model-dir";
import { runIdProblem } from "./lib/run-id";
import {
  assertPrivateMode,
  extractPrivateConfig,
  loadPrivateConfig,
  buildSecretsJson,
  buildSettingsJson,
  parsePrivateConfig,
  seedUserData,
  writePrivateConfig,
  type LlmPrivateConfig,
} from "./lib/config-seed";
import {
  appendSeeds,
  cardTemplate,
  countOpenQuestions,
  listed,
  parseRound,
  productTemplate,
  renderCard,
} from "./lib/prototype";
const REPO = resolve(import.meta.dirname, "../../../..");
const DESKTOP = join(REPO, "apps/desktop");
const VERIFY_ROOT = join(REPO, "tmp/verify");
const LATEST = join(VERIFY_ROOT, "latest");
/**
 * 证据目录之外的状态根（r49/r50）：userData（含 secrets.bin）只允许落在这里。
 * 证据 = 截图 + aria + 日志 + 产物；用户数据不是证据，混进去等于把密钥复制到每份验收记录里。
 */
const VERIFY_STATE_ROOT = join(REPO, "tmp/verify-state");

type RunState = {
  /** Platform the run drives; absent means mac (every state.json written before r41). */
  target?: "mac" | "win-gamepc";
  runId: string;
  runDir: string;
  port: number;
  /** For a win-gamepc run this is the remote Windows pid; the local ssh is sshTunnelPid. */
  pid: number;
  /** For a win-gamepc run home / userData / modelDir are the remote Windows paths. */
  home: string;
  userData: string;
  modelDir: string;
  /** Local copy of the app's stdout (win-gamepc pulls it into <run>/win/ on `down`). */
  appLog: string;
  /** Set when the run drives a packaged .app instead of apps/desktop. */
  appPath?: string;
  /** The repo commit the run was launched from; null when git could not be read. */
  commit?: string | null;
  startedAt: string;
  /** Set by `down` when it stops the instance. */
  stoppedAt?: string;
  electron: string;
  /** win-gamepc only: the ssh host alias (default gamepc). */
  sshHost?: string;
  /** win-gamepc only: the remote run directory, D:\code\video-notes\verify\<runId>. */
  remoteRunDir?: string;
  remoteHome?: string;
  remoteUserData?: string;
  remoteModelDir?: string;
  remoteAppLog?: string;
  /** The Windows executable the run launches ("Video Notes.exe" or an --app override). */
  remoteApp?: string;
  /** win-gamepc, --installer runs only: the NSIS /D= target the installer installed into. */
  installDir?: string;
  /** Local pid of `ssh -N -L <port>:127.0.0.1:<port>`, the CDP tunnel. */
  sshTunnelPid?: number;
  /** Task Scheduler entry that starts the app in interactive Session 1. */
  scheduledTask?: string;
  /** r45c: the run's userData was seeded from the private LLM config before launch. */
  configSeeded?: boolean;
  /** r54: Lab cache mode the dev app was started with (`--lab-cache=…`). */
  labCache?: string;
  /** r58: electron 的 dist/ 由本次 up 补装（记录实际跑过的命令，便于判断这次跑的是哪个二进制）。 */
  electronBootstrap?: string[];
};

const HELP = `usage: verify.ts <command>

  up [--port N] [--run ID] [--home DIR] [--user-data DIR] [--model-dir DIR] [--no-build]
     [--app PATH] [--min-path] [--empty-settings] [--lab-cache shared|isolated|cold]
     [--ready-timeout MS]
      Build apps/desktop, start Electron with isolated VNOTE_HOME / VNOTE_USER_DATA,
      wait until the renderer answers, write tmp/verify/<run>/state.json.
      Before anything is created the port is checked by listener identity: another app
      holding it fails with its pid and command line, and a leftover ssh tunnel from an
      earlier run on that port is recognised and cleared (never connected to).
      Readiness is polled (window.vnote + [data-testid=nav-library] + notesRoot identity)
      and the run continues the moment it is up; --ready-timeout (default 60000, packaged
      or dev) turns a slow first launch into a clear timeout error instead of a mystery.
      A failed launch stops the whole process tree: SIGTERM, then SIGKILL after the grace
      period, so no orphan Electron survives. The Electron binary is bootstrapped when a
      fresh worktree's \`bun install\` skipped dist/ (runs the package's install.js).
      userData defaults to tmp/verify-state/<run>/user-data, outside the evidence tree;
      an explicit --user-data inside tmp/verify is refused (secrets.bin must never be
      copied into the evidence).
      --app drives an already packaged .app (or its executable) instead of apps/desktop,
      and implies --no-build. --min-path replaces the child PATH with launchd's
      /usr/bin:/bin:/usr/sbin:/sbin so the packaged app's PATH repair is what finds ffmpeg.
      --lab-cache decides where the dev Diarization Lab reads/writes analysis entries
      (r54): shared = ~/.cache/video-notes/lab-cache shared by every worktree, isolated =
      a fresh empty temp dir per run, cold = shared dir but every query recomputes.
      Default isolated, because a QA run must not read or pollute the shared cache
      (runs are assertions about "first time"; pass --lab-cache=cold for a full recompute).
      Every run is seeded with the private LLM config (mac
      ~/.config/video-notes-verify/llm.json, win %USERPROFILE%\\.config\\video-notes-verify\\llm.json,
      both 0600 and outside the repo); a feature that asserts a virgin settings page
      (requires: empty-settings) passes --empty-settings instead.
  up --target win-gamepc [--installer PATH | --app WINPATH] [--install-dir WINPATH] [--ssh-host NAME]
     [--empty-settings] [--ready-timeout MS]
      Drive a Windows machine over ssh instead of this Mac (see Targets below).
      --installer runs the NSIS installer silently into --install-dir (default
      D:\\code\\video-notes\\app), --app drives an exe that is already installed; the two
      are mutually exclusive. --install-dir is ignored with --app.
      --ssh-host picks the ssh host alias (default gamepc).
      --ready-timeout (default 180000) is the window for the first launch to answer over
      the tunnel: the CDP connection is rebuilt every 250ms, which is what makes a fresh
      install's slow debug-port startup reliable.

  doctor [--run ID] [--target mac|win-gamepc]
      Read-only health check of the latest run: process, CDP port owner, build freshness,
      effective notes root, models/LLM readiness. Exit 1 on failure.

  drive <action> [args] [--run ID] [--target mac|win-gamepc]
      eval <expr>                 evaluate JS in the renderer, print JSON
      click <selector> [--index N]  real mouse click on the element's center
      click-text <label> [--index N]  real mouse click on a button/checkbox by text or aria-label
      type <text>                 key events into the focused element
      fill <selector> <text>      focus + select + type (works on inputs/textareas)
      press <key> [--meta]        press one key (e.g. Enter, Escape)
      drop <file> [--selector SEL]
                                drag a real file onto SEL[0] (default
                                [data-testid=dropzone]; e.g. [data-testid=lab-dropzone])
      drag <selector> <dx> <dy> [--index N] [--steps N]
                                real pointer drag: press at the element center, move in
                                N steps (default 8) to center+(dx,dy), release at the end
      wait <expr> [--timeout MS]  poll until the expression is truthy
      text                        print document.body.innerText
      clipboard [--save PATH]     print the OS clipboard (pbpaste on mac; the app's
                                  renderer on win) and save it
      shot [name]                 PNG screenshot -> <run>/<name>.png
      snapshot [name]             accessibility tree text -> <run>/<name>.aria.txt
      status                      library + active job + settings summary
      log [lines]                 tail the Electron log

  down [--run ID] [--purge] [--target mac|win-gamepc]
      Stop the Electron process this helper started (never kills by name), record
      stoppedAt in state.json, prune the renderer caches, keep the evidence.
      --purge also deletes the whole run directory (the default keeps it).
      A win-gamepc run also stops the ssh tunnel (SIGTERM, then SIGKILL), kills the remote
      process, deletes the scheduled task and prunes the remote caches. It then pulls the
      WHOLE remote run directory except caches — one inventory, verified file by file
      against the remote listing and retried once — into <run>/win/, and fails when
      anything is still missing. app.log, home\\logs and every video.json / topic.md /
      labels.json / analysis.json / trajectory.json / status.json included.
      Media binaries above 8 MiB (topic.mp4, extracted wav, …) are derived products and
      are listed in evidence-inventory.json as skippedMedia instead of pulled: the
      transfer is base64 over ssh with a 64 MiB capture limit, so large media cannot be
      pulled intact. Every pulled file is size-checked; a gap fails the command.

  tunnels [--kill] [--pid PID]
      List every local ssh -L tunnel with its port, whether it is CDP-shaped
      (ssh -N -L <port>:127.0.0.1:<port>, this harness) and which run recorded it
      (searched across every git worktree of this repo), or "residue" when none did.
      --kill only stops CDP-shaped tunnels with no live owner; a live run's tunnel and a
      plain forward (ssh -L 5432:127.0.0.1:5432 db-host) are left alone unless you name
      the pid with --pid. \`up\` does the same for the port it is about to use (after
      probing that nothing CDP answers behind it), and \`doctor\` warns while one is alive.

  seed-config [--run ID] [--target mac|win-gamepc]
      Write the private LLM config into an existing run's userData (settings.json + secrets.bin).
      Restart the run afterwards; \`up\` does this automatically unless --empty-settings.

  export-private-config [--target mac|win-gamepc] [--ssh-host NAME]
      One-off: copy the installed app's LLM baseUrl/model/key into the private config file
      (0600 on mac, current-user ACL on Windows). Never prints any value.

  runs
      List runs and whether each process is still alive.

  secrets-gate
      Hard gate: scan tmp/verify for secrets.bin / secrets.pending / secrets.bin.legacy-*
      and exit 1 (printing the paths) when any is found. up, down and doctor run the same
      assertion, because the harness must never put userData inside the evidence tree.

  detect [--run ID] [--target mac|win-gamepc] [--source-only]
      Hard gate: \`impeccable detect --json\` over apps/desktop/src/renderer/src
      (never the repo root, never tmp/) plus, unless --source-only, a live scan of
      the running Electron over CDP (\`detect --cdp <port>\` from state.json; the
      live scan is not a business check — if a live run exists but cannot be
      scanned the gate fails, it does not pass silently). Zero primary findings
      (severity error/warning/high) is required; advisory items are reported and
      never block. The merged report lands in <run>/impeccable-report.json
      (tmp/verify/latest-impeccable-report.json without a run) and, for a
      win-gamepc target, also <run>/win/impeccable-report.json.
      Exit 1 on any primary finding or on a failed scan.

  prototype [--run ID] --round <N> [--seed "…"] [--confirmed "…"] [--rejected "…"]
            [--open "…"] [--freeze] [--target mac|win-gamepc]
      Multi-round design-prototype loop. Round mode: scaffolds PRODUCT.md when
      missing (a structured template), appends --seed into it, runs
      \`impeccable concept-seed\` (no positional args, no --json; it refuses to run
      without PRODUCT.md in the working directory) into
      .impeccable/concept-seed.txt, and creates/updates
      .impeccable/rounds/round-<N>-decision-card.md with its
      .impeccable/briefs/round-<N>-decisions.md mirror. --open "None"/"无"/
      "clear" resets the Open Questions section. \`--freeze\` is the QA baseline
      gate: PRODUCT.md + DESIGN.md + this round's decision card must exist, the
      Open Questions must be empty, \`impeccable detect\` must report 0 primary
      findings, and the live Electron (CDP) must expose the required
      [data-testid] selectors (app-version, nav-library, breadcrumb) — then the
      baseline is exported to .impeccable/baseline/ (baseline.png, selectors.json,
      impeccable-report.json, freeze-manifest.json). Exit 1 on any failed check.

  Targets
    mac        (default) evidence lives in <repo>/tmp/verify/<run>/; userData (settings +
               secrets.bin) lives outside it in <repo>/tmp/verify-state/<run>/user-data.
               up builds apps/desktop and launches it locally. --target mac is the old behaviour.
    win-gamepc a Windows machine reached over ssh. No config file; the layout is fixed:
                 root      D:\\code\\video-notes
                 run dir   D:\\code\\video-notes\\verify\\<run>
                 home      <run>\\home        user-data D:\\code\\video-notes\\verify-state\\<run>\\user-data
                 app log   <run>\\app.log     launch    <run>\\launch.ps1
                 models    C:\\Users\\xieal\\Documents\\video-notes\\models
                 app       <install-dir>\\Video Notes.exe (default D:\\code\\video-notes\\app,
                          the NSIS /D= target of --installer; --install-dir overrides it)
                 staging   D:\\code\\video-notes\\installer\\
               Local evidence stays in <repo>/tmp/verify/<run>/; Windows artifacts are
               pulled into <repo>/tmp/verify/<run>/win/. The app starts in interactive
               Session 1 through schtasks (ssh lands in Session 0, which has no desktop),
               the CDP port is forwarded with ssh -N -L <port>:127.0.0.1:<port>, and the
               launcher is launch.ps1 (UTF-8 with BOM: the script may name a non-ASCII
               install dir, but the scheduled-task action itself is pure ASCII) and it
               neutralises HTTP(S)_PROXY so the remote Surge proxy cannot answer 503
               for localhost traffic. doctor, drive and down default to the target
               recorded in state.json.
`;

function fail(message: string): never {
  process.stderr.write(`verify: ${message}\n`);
  process.exit(1);
}

function takeFlag(args: string[], name: string): string | undefined {
  // `--name=value` 与 `--name value` 都认（docs 里两种写法都出现过，静默忽略等于悄悄用默认值）。
  const prefixed = args.findIndex((arg) => arg.startsWith(`${name}=`));
  if (prefixed !== -1) {
    const value = args[prefixed]?.slice(name.length + 1) ?? "";
    args.splice(prefixed, 1);
    if (value === "") fail(`${name} needs a value`);
    return value;
  }
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) fail(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

function hasFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function revParse(): string | null {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO });
    if (r.exitCode !== 0) return null;
    const out = r.stdout.toString().trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}


/**
 * 只读命令也要同一条 run id 边界（r51）：run id 会拼进 `tmp/verify/<id>`，而 `down --purge`
 * 会按 state.json 里的 pid / runDir 动手。显式 `--run` 与 latest 指针内容都过 `runIdProblem`；
 * 没有 run 时返回 null，由调用方决定是报错还是当作“还没有 run”。
 */
function checkedRunId(runId: string | undefined): string | null {
  const id = runId ?? readLatestPointer(LATEST);
  if (id === null) return null;
  const problem = runIdProblem(id);
  if (problem !== null) fail(`${problem}\n来源：${runId === undefined ? "tmp/verify/latest" : "--run"}`);
  return id;
}

function readState(runId?: string): RunState {
  const id = checkedRunId(runId);
  if (id === null) fail("no verification run yet: run `verify.ts up` first");
  const dir = join(VERIFY_ROOT, id);
  const file = join(dir, "state.json");
  if (!existsSync(file)) fail(`no state.json in ${dir}`);
  // Older state.json files lack commit / startedAt / stoppedAt; the optional type tolerates them.
  const state = JSON.parse(readFileSync(file, "utf8")) as RunState;
  // 运行编号校验（r58）：state.json 里的 runId 必须与目录名一致，否则 pid/端口/收尾路径都对不上
  if (state.runId !== id) {
    fail(`运行编号不一致：${dir}/state.json 记录的 runId 是 ${JSON.stringify(state.runId)}，目录名是 ${id}。\n` +
      `这份 state.json 不可信（pid / 端口 / 证据路径都可能指向别的 run）；确认后再手工修正或换一个 --run。`);
  }
  return state;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processName(pid: number): string {
  const r = Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="]);
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}


/** launchd hands GUI apps this PATH; a packaged run must not borrow the shell's. */
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** A .app bundle runs its CFBundleExecutable; a plain path runs as-is. */
function bundleExecutable(appPath: string): string {
  if (!existsSync(appPath)) fail(`app not found: ${appPath}`);
  if (!appPath.endsWith(".app")) return appPath;
  const plist = join(appPath, "Contents/Info.plist");
  const name = Bun.spawnSync(["plutil", "-extract", "CFBundleExecutable", "raw", "-o", "-", plist]).stdout.toString().trim();
  if (name === "") fail(`cannot read CFBundleExecutable from ${plist}`);
  const exe = join(appPath, "Contents/MacOS", name);
  if (!existsSync(exe)) fail(`bundle executable missing: ${exe}`);
  return exe;
}

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

async function waitFor(cdp: Cdp, expression: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    try {
      if (await cdp.eval<boolean>(expression)) return;
    } catch (err) {
      last = String(err);
    }
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${expression}${last === "" ? "" : ` (${last})`}`);
}

/**
 * r58：启动前的端口预检。要么报冲突，要么清掉上一轮自己的隧道，绝不连到别的应用。
 *
 * 判据是监听者身份而不是「CDP 有没有应答」：端口被非 CDP 的应用占着时，旧代码把
 * `listTargets` 的异常当成「端口空闲」，拉起 app 后再连上的其实是别人。
 */
type TunnelOwner = { runId: string; live: boolean; root: string };

/** 所有可能记录隧道的证据根：本 worktree + `git worktree list` 里的其它 worktree。 */
function knownVerifyRoots(): string[] {
  const roots = new Set<string>([VERIFY_ROOT]);
  const listed = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: REPO, stdout: "pipe", stderr: "ignore" });
  for (const line of listed.stdout.toString().split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    roots.add(join(line.slice("worktree ".length).trim(), "tmp/verify"));
  }
  return [...roots];
}

/**
 * 谁记录了这个隧道 pid。`live` 表示那一轮还没 down（隧道仍归它用）。
 * 跨 worktree 查是必须的：另一个 worktree 正在跑的 win 验证也用这种形状的隧道，
 * 只看本目录会把别人的活跃会话当残留杀掉。
 */
function tunnelOwner(pid: number): TunnelOwner | null {
  for (const root of knownVerifyRoots()) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const file = join(root, entry, "state.json");
      if (!existsSync(file)) continue;
      try {
        const state = JSON.parse(readFileSync(file, "utf8")) as RunState;
        if (state.sshTunnelPid !== pid) continue;
        return { runId: state.runId ?? entry, live: state.stoppedAt === undefined, root };
      } catch {
        // 坏掉的 state.json 不该让预检失效
      }
    }
  }
  return null;
}

/** 这个端口上有没有一个真的在应答的 CDP 服务（隧道对端还活着时就会应答）。 */
async function cdpAnswers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return false;
    const body = (await res.json()) as { webSocketDebuggerUrl?: unknown };
    return typeof body.webSocketDebuggerUrl === "string";
  } catch {
    return false;
  }
}

async function reservePort(port: number): Promise<void> {
  const state = inspectPort(port);
  const conflict = portConflict(state);
  if (conflict === null) return;
  if (conflict.kind === "occupied") {
    fail(
      `端口被占用（${port}）：\n  ${describeListeners(conflict.owners)}\n` +
        `换一个 --port，或先停掉占用者；验证脚本不会连到别的应用/旧进程上。`,
    );
  }
  if (conflict.kind === "foreign-tunnel") {
    const pid = conflict.owners[0]?.pid;
    fail(
      `端口被占用（${port}）：一条 ssh 隧道占着它，但不是本 harness 的 CDP 隧道（本地端口 ≠ 远端端口）：\n  ${describeListeners(conflict.owners)}\n` +
        `确认是上一轮残留后再清（verify.ts tunnels --kill --pid ${pid ?? "<pid>"}），或者换一个 --port。`,
    );
  }
  // 隧道后面可能还有一个活着的 CDP 服务（别的会话正在用）：先探活，能应答就不动它
  if (await cdpAnswers(port)) {
    fail(
      `端口被占用（${port}）：隧道后面有活的 CDP 服务在应答（多半是另一个仍在运行的验证会话）。\n` +
        `  ${describeListeners(state.listeners)}\n` +
        `先收尾那一轮，或换一个 --port；这里不会替你杀掉别人的会话。`,
    );
  }
  for (const pid of conflict.pids) {
    const owner = tunnelOwner(pid);
    if (owner?.live === true) {
      fail(
        `端口被占用（${port}）：${owner.root === VERIFY_ROOT ? "" : `${owner.root} 里`}run ${owner.runId} 的 ssh 隧道 pid ${pid} 还在用这个端口。\n` +
          `先收尾那一轮（verify.ts down --run ${owner.runId}），或换一个 --port。`,
      );
    }
    // 只自动清「CDP 形状 + 没有活跃 owner + 对端无应答」的隧道；形状不符的由人用 tunnels --kill --pid 决定
    const stopped = await stopProcessTree(pid, { termMs: 3000, killMs: 2000 });
    process.stderr.write(`verify: 清掉上一轮残留隧道——${describeStop(stopped)}（端口 ${port}）\n`);
    if (stopped.survivors.length > 0) fail(`残留隧道 pid ${pid} 收不掉：先 kill -9 ${pid} 再重试`);
    console.log(`tunnel:   清掉上一轮残留隧道 pid ${pid}（端口 ${port}，${owner === null ? "没有 run 记录它" : `run ${owner.runId} 已收尾`}）`);
  }
}

/** --port 必须是 1..65535 的整数：`Number("abc")` 是 NaN，监听 NaN 只会得到莫名其妙的失败。 */
function portFlag(args: string[]): number {
  const raw = takeFlag(args, "--port") ?? "9411";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`--port 必须是 1..65535 的整数（收到 ${JSON.stringify(raw)}）`);
  return port;
}

/** 打包版首启可能几十秒：等待上限可调，但必须是有限毫秒数（r58 去掉了写死的 20 秒）。 */
function readyTimeoutFlag(args: string[], fallback: number): number {
  const raw = takeFlag(args, "--ready-timeout");
  if (raw === undefined) return fallback;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 200) fail(`--ready-timeout 必须是 >=200 的毫秒数（收到 ${JSON.stringify(raw)}）`);
  return ms;
}

/** 认不出的参数一律报错：静默忽略会让 `--prot 9412` 悄悄用默认端口起一个实例。 */
function rejectUnknownArgs(args: string[], usage: string): void {
  if (args.length === 0) return;
  fail(`未知参数：${args.join(" ")}\n${usage}\n用 --help 看完整用法。`);
}

/** Windows 路径比较：分隔符、尾部分隔符与大小写都不敏感（`notesRoot` 由 app 自己拼）。 */
function sameWinPath(a: string, b: string): boolean {
  const norm = (path: string) => path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

type ReadinessProbe = { ready: boolean; readyState: string; navLibrary: boolean; notesRoot: string | null };

const READINESS_EXPRESSION = `(async () => {
  const settings = typeof window.vnote === "object" ? await window.vnote.settings().catch(() => null) : null;
  return {
    readyState: document.readyState,
    navLibrary: document.querySelector('[data-testid=nav-library]') !== null,
    notesRoot: settings === null ? null : settings.notesRoot,
    ready: typeof window.vnote === "object" && document.querySelector('[data-testid=nav-library]') !== null,
  };
})()`;

/** 单个 promise 的上限：白屏时 renderer 主线程会被阻塞，eval / ws 握手都可能永不结算。 */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 超过 ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 轮询到「可用」为止（r58）：就绪即继续，超时给出明确报错（最后观察到的状态 + 端口 + 上限）。
 * 顺带校验对端身份：CDP 上应答的实例必须是本次启动的那一个（notesRoot = 本 run 的隔离 home）。
 * 每次都重新 `Cdp.open`：Windows 首启的调试端口偶发连不上，重连比一次性连上更可靠。
 * 每次连接与求值都受剩余期限约束：app 的 settings() 可能长时间不返回，不能让一次求值越过
 * 整个 --ready-timeout，也不能让卡死的 renderer 把 up 的失败收尾永远拖住。
 */
async function waitUntilReady(options: {
  port: number;
  home: string;
  timeoutMs: number;
  win: boolean;
  /** 进程/隧道本身没了就别等满上限 */
  guard?: () => string | null;
}): Promise<number> {
  const started = Date.now();
  const deadline = started + options.timeoutMs;
  const remaining = () => Math.max(200, deadline - Date.now());
  let last = "CDP 端口还没有 page target";
  while (Date.now() < deadline) {
    const dead = options.guard?.();
    if (dead !== null && dead !== undefined) throw new Error(dead);
    let cdp: Cdp | undefined;
    try {
      cdp = await withDeadline(Cdp.open(options.port), remaining(), `CDP 连接 ${options.port}`);
      const probe = await withDeadline(cdp.eval<ReadinessProbe>(READINESS_EXPRESSION), Math.min(5000, remaining()), "就绪探测");
      last = `readyState=${probe.readyState}, nav-library=${probe.navLibrary}, notesRoot=${JSON.stringify(probe.notesRoot)}`;
      if (probe.ready) {
        const same = probe.notesRoot !== null && (options.win ? sameWinPath(probe.notesRoot, options.home) : probe.notesRoot === options.home);
        if (!same) {
          throw new Error(
            `端口 ${options.port} 上应答的不是本次启动的实例：notesRoot=${JSON.stringify(probe.notesRoot)}，期望 ${options.home}；` +
              "先确认没有残留的实例/隧道占用该端口",
          );
        }
        return Date.now() - started;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 对端身份不符不是「还没就绪」，等下去只会连到别人
      if (message.includes("不是本次启动的实例")) throw err;
      last = message;
    } finally {
      cdp?.close();
    }
    await sleep(250);
  }
  throw new Error(`app 没有就绪（等待 ${options.timeoutMs}ms 超时，端口 ${options.port}）：${last}`);
}

async function elementCenter(cdp: Cdp, selector: string, index: number): Promise<{ x: number; y: number }> {
  const rect = await cdp.eval<{ x: number; y: number } | null>(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (el === undefined || el === null) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (rect === null) throw new Error(`element not found or not visible: ${selector}[${index}]`);
  return rect;
}

async function click(cdp: Cdp, selector: string, index: number): Promise<void> {
  await waitFor(cdp, `document.querySelectorAll(${JSON.stringify(selector)}).length > ${index}`, 5000);
  const { x, y } = await elementCenter(cdp, selector, index);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function type(cdp: Cdp, text: string): Promise<void> {
  for (const ch of text) {
    if (ch.codePointAt(0)! > 127) {
      await cdp.send("Input.insertText", { text: ch });
      continue;
    }
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  }
}

async function fill(cdp: Cdp, selector: string, text: string): Promise<void> {
  await click(cdp, selector, 0);
  const selected = await cdp.eval<boolean>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    if (typeof el.select === "function") { el.select(); return true; }
    return false;
  })()`);
  if (!selected) await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 4, commands: ["selectAll"] });
  await type(cdp, text);
}

async function drop(cdp: Cdp, file: string, selector: string, winPath?: string): Promise<void> {
  // a win run's app reads the remote filesystem: the Windows path was validated over ssh already
  const path = winPath ?? resolve(file);
  if (winPath === undefined && !existsSync(path)) fail(`file not found: ${path}`);
  const { x, y } = await elementCenter(cdp, selector, 0);
  const data = { items: [], files: [path], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await cdp.send("Input.dispatchDragEvent", { type, x, y, data });
  }
}

// 真实指针拖拽：在元素中心按下，分 N 步移动到 中心+(dx,dy)，再在终点松开。
async function drag(cdp: Cdp, selector: string, index: number, dx: number, dy: number, steps: number): Promise<void> {
  await waitFor(cdp, `document.querySelectorAll(${JSON.stringify(selector)}).length > ${index}`, 5000);
  const { x, y } = await elementCenter(cdp, selector, index);
  const end = { x: x + dx, y: y + dy };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + dx * f, y: y + dy * f, button: "left", buttons: 1 });
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", clickCount: 1 });
  console.log(`dragged ${selector}[${index}] (${x}, ${y}) -> (${end.x}, ${end.y}) in ${steps} steps`);
}


function newestSourceMtime(): number {
  let newest = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) newest = Math.max(newest, statSync(path).mtimeMs);
    }
  };
  walk(join(DESKTOP, "src"));
  walk(join(REPO, "packages/core/src"));
  for (const file of [join(DESKTOP, "electron.vite.config.ts"), join(DESKTOP, "package.json")]) {
    if (existsSync(file)) newest = Math.max(newest, statSync(file).mtimeMs);
  }
  return newest;
}

const OUTPUTS = [
  join(DESKTOP, "out/main/index.js"),
  join(DESKTOP, "out/preload/index.cjs"),
  join(DESKTOP, "out/renderer/index.html"),
];

// --------------------------------------------------------------- Windows target

/** The Windows machine has a fixed layout: one root, no config file. */
const WIN_ROOT = "D:\\code\\video-notes";
const WIN_RUNS = `${WIN_ROOT}\\verify`;
const WIN_INSTALLER_DIR = `${WIN_ROOT}\\installer`;
/** 远端 userData 根（r50）：证据 staging 目录 D:\code\video-notes\verify 之外。 */
const WIN_STATE_ROOT = `${WIN_ROOT}\\verify-state`;
const WIN_MODEL_DIR = "C:\\Users\\xieal\\Documents\\video-notes\\models";
const WIN_SSH_HOST = "gamepc";

// --------------------------------------------------------- private verify config

/**
 * LLM config for every new run. Deliberately outside the repo, 0600, one file per machine:
 *   mac      ~/.config/video-notes-verify/llm.json
 *   windows  %USERPROFILE%\.config\video-notes-verify\llm.json
 * The repo only carries `.omp/skills/verify-video-notes/config/llm.example.json`.
 * A feature that needs a virgin settings page starts its run with `up --empty-settings`.
 */
const PRIVATE_CONFIG_EXAMPLE = join(REPO, ".omp/skills/verify-video-notes/config/llm.example.json");
const PRIVATE_CONFIG_MAC = join(process.env.HOME ?? ".", ".config/video-notes-verify/llm.json");
/** Real userData of the installed mac app; export-private-config reads it once. */
const MAC_INSTALLED_USER_DATA = join(process.env.HOME ?? ".", "Library/Application Support/Video Notes");

type Platform = "mac" | "win-gamepc";

type SshResult = { code: number; stdout: string; stderr: string };

/** A remote command exited non-zero; the message carries the command so it can be rerun by hand. */
class RemoteError extends Error {}

/** --target defaults to mac; doctor / drive / down fall back to the target in state.json. */
function resolveTarget(explicit: string | undefined, state?: Pick<RunState, "target">): Platform {
  const value = explicit ?? state?.target ?? "mac";
  if (value !== "mac" && value !== "win-gamepc") {
    fail(`unknown --target ${JSON.stringify(value)}: expected mac or win-gamepc`);
  }
  if (value === "win-gamepc") neutraliseProxy();
  return value;
}

/**
 * The Surge proxy on the Windows box answers 503 for intercepted localhost traffic, and a
 * proxied `ssh -L` never forwards: no proxy for this process or anything it spawns.
 */
function neutraliseProxy(): void {
  process.env.NO_PROXY = "127.0.0.1,localhost,*";
  process.env.no_proxy = "127.0.0.1,localhost,*";
  for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    delete process.env[key];
  }
}

/** A drive-qualified path (C:\…, D:/…) or a UNC share (\\host\share). */
function isWinPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path);
}

/** ssh hands the command to the remote default shell, so every Windows command names its own. */
function winCmd(command: string): string {
  return `cmd.exe /c "${command}"`;
}

/** PowerShell where a reply has to be read back; keep the script free of double quotes. */
function winPs(script: string): string {
  // a redirected console writes the OEM code page (GBK on the zh-CN box), so Chinese log and
  // clipboard text would arrive as replacement characters; the encoding is pinned per call
  return `pwsh -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}"`;
}

/** Encode PowerShell as UTF-16LE -EncodedCommand to avoid cmd.exe quoting and Defender command-line false positives. */
function winPsEncoded(script: string): string {
  const full = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`;
  return `pwsh -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(full, "utf16le").toString("base64")}`;
}

function sshExec(host: string, command: string): SshResult {
  // a pull sends a whole file as base64 on stdout: do not let the default capture limit cut it
  const result = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, command], { maxBuffer: 64 * 1024 * 1024 });
  return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** Last five stderr lines: the tail every remote failure is reported with. */
function stderrTail(result: SshResult): string {
  return result.stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .slice(-5)
    .join("\n");
}

/** Run a remote command; a non-zero exit fails with the command, its code and the stderr tail. */
function sshRun(host: string, command: string): SshResult {
  const result = sshExec(host, command);
  if (result.code !== 0) {
    throw new RemoteError(`remote command failed (exit ${result.code}) on ${host}: ${command}\n${stderrTail(result)}`);
  }
  return result;
}

/** Local evidence directory for remote artifacts: <run>/win. */
function winLocal(state: Pick<RunState, "runDir">): string {
  const dir = join(state.runDir, "win");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A drop path must resolve on the Windows box: the remote app never sees this Mac's filesystem. */
function winDropPath(host: string, file: string): string {
  if (!isWinPath(file)) {
    throw new RemoteError(`drop on a win run needs a Windows path the remote app can read, not the POSIX path ${file}`);
  }
  const probe = winCmd(`if exist "${file}" (exit 0) else (exit 1)`);
  const result = sshExec(host, probe);
  if (result.code !== 0) {
    throw new RemoteError(`remote file missing (exit ${result.code}) on ${host}: ${probe}\n${stderrTail(result)}`);
  }
  return file;
}

/** Copy one remote file in a single round trip: base64 on stdout, so only exec is needed. */
function pullRemoteFile(host: string, remotePath: string, localPath: string): boolean {
  // 路径按 base64 传：视频标题里的单/双引号、`$`、中文都不能进 -Command 的引号边界
  const encodedPath = Buffer.from(remotePath, "utf8").toString("base64");
  const result = sshExec(
    host,
    winPsEncoded(
      `[Convert]::ToBase64String([IO.File]::ReadAllBytes([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))))`,
    ),
  );
  if (result.code !== 0) return false;
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, Buffer.from(result.stdout.replace(/\s+/g, ""), "base64"));
  return true;
}

// ------------------------------------------------------- private config (r45c)

function configMissingMessage(path: string): string {
  return [
    `缺少私有 LLM 配置：${path}`,
    `  1) 复制模板：${PRIVATE_CONFIG_EXAMPLE}`,
    `  2) 填入真实 baseUrl / apiKey / model`,
    `  3) 收紧权限：chmod 600 ${path}（Windows 用 icacls /inheritance:r /grant:r "$env:USERNAME:(F)"）`,
    "  也可以先跑 `verify.ts export-private-config` 从已安装应用导出。",
  ].join("\n");
}

/**
 * The run's LLM config comes only from the seeded files: an ambient VNOTE_LLM_* / IDEALSOFT_*
 * (dev seed contract) would silently win over them and make --empty-settings non-empty.
 */
function withoutLlmEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("VNOTE_LLM_") || key.startsWith("IDEALSOFT_")) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 证据目录里永远不许出现 userData（r49/r50）。默认 userData 已挪到 VERIFY_STATE_ROOT；
 * 显式 --user-data 一旦指回证据目录，直接拒绝，而不是先写密钥再靠人记得清理。
 */
function assertUserDataOutsideEvidence(userData: string): void {
  if (!isInside(VERIFY_ROOT, userData)) return;
  fail(
    `userData 不能落在证据目录内：${userData}\n` +
      `默认位置是 ${join(VERIFY_STATE_ROOT, "<run>", "user-data")}；证据目录只放截图/日志/产物。\n` +
      `旧 run 的 userData 在 tmp/verify 里时请用 down --purge 丢弃后重跑。`,
  );
}

/**
 * 门禁文案。命中时由调用方决定是 fail（无活资源）还是抛给清理路径（远端 app / tunnel 已起）。
 */
function secretsFailureMessage(context: string, found: string[]): string {
  return (
    `${context}：证据目录里有 ${found.length} 个密钥文件（tmp/verify 不允许出现 userData）\n` +
    `${found.map((path) => `  ${path}`).join("\n")}\n` +
    `删除后再跑；harness 的 userData 现在落在 ${VERIFY_STATE_ROOT}。`
  );
}

/** 证据目录密钥门禁：命中即失败，打印路径，由人决定是否删除。 */
function assertNoSecretsInEvidence(context: string): void {
  const found = findSecretFiles(VERIFY_ROOT);
  if (found.length > 0) fail(secretsFailureMessage(context, found));
}

/** Seed one local (mac) run userData before the app starts. */
function seedLocalRunConfig(userData: string): void {
  if (existsSync(PRIVATE_CONFIG_MAC)) assertPrivateMode(statSync(PRIVATE_CONFIG_MAC).mode, PRIVATE_CONFIG_MAC);
  const cfg = loadPrivateConfig(PRIVATE_CONFIG_MAC, { repoRoot: REPO, examplePath: PRIVATE_CONFIG_EXAMPLE });
  seedUserData(userData, cfg);
}

/** Read one file out of a remote directory expression; null when absent. */
function remoteUserDataFile(host: string, dirExpr: string, name: string): string | null {
  const script = `$p = Join-Path ${dirExpr} '${name}'; if (Test-Path -LiteralPath $p) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($p)) } else { 'MISSING' }`;
  const out = sshRun(host, winPsEncoded(script)).stdout.trim();
  if (out === "MISSING" || out === "") return null;
  return Buffer.from(out, "base64").toString("utf8");
}

function writeRemoteTextFile(host: string, path: string, text: string): void {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  sshRun(
    host,
    winPsEncoded(
      `[IO.File]::WriteAllText('${path}', [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')), (New-Object Text.UTF8Encoding $false)); 'ok'`,
    ),
  );
}

/** The Windows private file, fetched over ssh; permission check is ACL-based (no broad ACEs). */
function remotePrivateConfig(host: string): LlmPrivateConfig {
  const script = [
    `$p = Join-Path $env:USERPROFILE '.config\\video-notes-verify\\llm.json'`,
    `if (-not (Test-Path -LiteralPath $p)) { Write-Output 'MISSING'; exit 0 }`,
    `$acl = Get-Acl -LiteralPath $p`,
    `$broad = @($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and ($_.IdentityReference.Value -match 'Everyone|Users|Authenticated') }).Count`,
    `[pscustomobject]@{ b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($p)); broad = $broad } | ConvertTo-Json -Compress`,
  ].join("; ");
  const out = sshRun(host, winPsEncoded(script)).stdout.trim();
  if (out === "MISSING") throw new RemoteError(configMissingMessage("%USERPROFILE%\\.config\\video-notes-verify\\llm.json"));
  const line = out.split(/\r?\n/).filter((l) => l.trim().startsWith("{")).pop();
  if (line === undefined) throw new RemoteError(`unexpected reply while reading the private config on ${host}: ${out}`);
  const parsed = JSON.parse(line) as { b64?: unknown; broad?: unknown };
  if (parsed.broad !== 0) {
    throw new RemoteError(
      `私有 LLM 配置权限过宽（存在 Everyone/Users 访问项）：在 Windows 上运行 icacls "$env:USERPROFILE\\.config\\video-notes-verify\\llm.json" /inheritance:r /grant:r "$env:USERNAME:(F)"`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(String(parsed.b64 ?? ""), "base64").toString("utf8"));
  } catch {
    throw new RemoteError("私有 LLM 配置不是合法 JSON");
  }
  return parsePrivateConfig(raw);
}

/** Write the private file on the Windows box and lock its ACL to the current user. */
function writeRemotePrivateConfig(host: string, cfg: LlmPrivateConfig): void {
  const body = `${JSON.stringify({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, ...(cfg.model === null ? {} : { model: cfg.model }) }, null, 2)}\n`;
  const b64 = Buffer.from(body, "utf8").toString("base64");
  const script = [
    `$dir = Join-Path $env:USERPROFILE '.config\\video-notes-verify'`,
    `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
    `$p = Join-Path $dir 'llm.json'`,
    `[IO.File]::WriteAllText($p, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')), (New-Object Text.UTF8Encoding $false))`,
    `icacls $p /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null`,
    `'ok'`,
  ].join("; ");
  sshRun(host, winPsEncoded(script));
}

/** Seed a remote (win-gamepc) run userData: same two files the app reads, key file ACL-restricted. */
function seedRemoteRunConfig(host: string, remoteUserData: string): void {
  const cfg = remotePrivateConfig(host);
  const dir = `'${remoteUserData}'`;
  const settings = buildSettingsJson(remoteUserDataFile(host, dir, "settings.json"), cfg);
  const secrets = buildSecretsJson(remoteUserDataFile(host, dir, "secrets.bin"), cfg);
  writeRemoteTextFile(host, `${remoteUserData}\\settings.json`, settings);
  writeRemoteTextFile(host, `${remoteUserData}\\secrets.bin`, secrets);
  sshRun(
    host,
    winPsEncoded(`icacls '${remoteUserData}\\secrets.bin' /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null; 'ok'`),
  );
}

function readLocalFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** One-off export from the installed app into the private file (prints no values). */
async function exportPrivateConfig(args: string[]): Promise<void> {
  const target = resolveTarget(takeFlag(args, "--target"));
  const host = takeFlag(args, "--ssh-host") ?? WIN_SSH_HOST;
  if (target === "win-gamepc") {
    const winDir = "(Join-Path $env:APPDATA 'Video Notes')";
    const settings = remoteUserDataFile(host, winDir, "settings.json");
    if (settings === null) fail(`已安装应用没有 settings.json：%APPDATA%\\Video Notes；请先在应用的设置页填写一次 LLM`);
    const secrets = remoteUserDataFile(host, winDir, "secrets.bin");
    const cfg = extractPrivateConfig(settings, secrets);
    writeRemotePrivateConfig(host, cfg);
    console.log("wrote %USERPROFILE%\\.config\\video-notes-verify\\llm.json (ACL: 当前用户); baseUrl/model/key 未回显");
    return;
  }
  const settings = readLocalFileOrNull(join(MAC_INSTALLED_USER_DATA, "settings.json"));
  if (settings === null) fail(`已安装应用没有 settings.json：${MAC_INSTALLED_USER_DATA}/settings.json；请先在应用的设置页填写一次 LLM`);
  const secrets = readLocalFileOrNull(join(MAC_INSTALLED_USER_DATA, "secrets.bin"));
  const cfg = extractPrivateConfig(settings, secrets);
  writePrivateConfig(PRIVATE_CONFIG_MAC, cfg);
  console.log(`wrote ${PRIVATE_CONFIG_MAC} (0600); baseUrl/model/key 未回显`);
}

/** seed-config: write the private config into an existing run's userData (restart needed). */
async function seedConfig(args: string[]): Promise<void> {
  const state = readState(takeFlag(args, "--run"));
  const target = resolveTarget(takeFlag(args, "--target"), state);
  if (target === "win-gamepc") {
    const remoteUserData = state.remoteUserData;
    if (remoteUserData === undefined) fail("this run has no remoteUserData");
    // 同一条远端边界规则：pre-r50 的 run 其 remoteUserData 就在 staging 里，不能往里再写密钥
    if (winPathInside(WIN_RUNS, remoteUserData)) {
      fail(
        `${remoteUserData} 在远端证据目录 ${WIN_RUNS} 内，不再往里写密钥。\n` +
          `用 down --purge 丢掉旧 run，再按新布局重跑（userData 默认在 ${WIN_STATE_ROOT}\\<run>\\user-data）。`,
      );
    }
    seedRemoteRunConfig(state.sshHost ?? WIN_SSH_HOST, remoteUserData);
    console.log(`seeded ${remoteUserData}\\settings.json + secrets.bin (ACL: 当前用户)`);
  } else {
    assertUserDataOutsideEvidence(state.userData);
    seedLocalRunConfig(state.userData);
    console.log(`seeded ${state.userData}/settings.json + secrets.bin (0600)`);
  }
  console.log("restart the run (`verify.ts down` then `verify.ts up`) for the app to read the seeded settings");
}

/** Windows runs live on another machine: ask it instead of the local process table. */
function remoteAlive(state: RunState): boolean {
  const host = state.sshHost ?? WIN_SSH_HOST;
  const probe = winPs(`if (Get-Process -Id ${state.pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`);
  return sshExec(host, probe).stdout.trim() === "alive";
}

/** The app's pid: the process running our exe with this --remote-debugging-port. */
function remoteMainPid(host: string, remoteApp: string, port: number): number {
  const exe = remoteApp.split(/[\\/]/).pop() ?? remoteApp;
  const probe = winPs(
    `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '${exe}' -and $_.CommandLine -like '*--remote-debugging-port=${port}*' } | Select-Object -First 1 -ExpandProperty ProcessId`,
  );
  const pid = Number(sshRun(host, probe).stdout.trim());
  if (!Number.isFinite(pid) || pid <= 0) throw new RemoteError(`no remote pid for ${exe} on port ${port}: ${probe}`);
  return pid;
}

async function up(args: string[]): Promise<void> {
  // resolved before anything is created: an unknown --target must leave tmp/verify untouched
  const target = resolveTarget(takeFlag(args, "--target"));
  const port = portFlag(args);
  const runId = takeFlag(args, "--run") ?? stamp();
  // 建目录、拉 app 之前先拒绝：保留名/分隔符/../ 一律不过（lib/run-id.ts）
  checkedRunId(runId);
  // 启动前先拒绝：历史 run 的 secrets.bin 不该等 app 起来才报（那时进程已在跑，退出就留下孤儿）
  assertNoSecretsInEvidence("up");
  // 同理：latest 上如果是一份带 state.json 的 run，写指针时绝不覆盖；提前到拉 app 之前拒绝
  const latestProblem = latestPointerProblem(LATEST);
  if (latestProblem !== null) fail(latestProblem);
  if (target === "win-gamepc") {
    await upWin(args, port, runId);
    return;
  }
  const appArg = takeFlag(args, "--app");
  // 打包版首启比 dev 慢得多：默认给 60s，可用 --ready-timeout 调整；就绪即继续
  const readyTimeout = readyTimeoutFlag(args, 60000);
  // --app drives an already packaged bundle: building apps/desktop cannot change what it runs
  const skipBuild = hasFlag(args, "--no-build") || appArg !== undefined;
  const minPath = hasFlag(args, "--min-path");
  // features that assert a virgin settings page start with `up --empty-settings`
  const emptySettings = hasFlag(args, "--empty-settings");
  const runDir = join(VERIFY_ROOT, runId);
  if (existsSync(runDir)) fail(`run already exists: ${runDir}`);

  const home = resolve(takeFlag(args, "--home") ?? join(runDir, "home"));
  const userDataArg = takeFlag(args, "--user-data");
  const userData = resolve(userDataArg ?? join(VERIFY_STATE_ROOT, runId, "user-data"));
  assertUserDataOutsideEvidence(userData);
  // 默认 userData 目录残留（上一次 up 崩在写 state.json 之前）会让同名 run 直接继承旧凭据
  if (userDataArg === undefined && existsSync(userData)) {
    fail(
      `默认 userData 目录已存在：${userData}\n` +
        `同名 run 会复用它的 settings.json / secrets.bin（--empty-settings 就不再是空的）。\n` +
        `换一个 --run，或先删除该目录；确实要复用旧 profile 时显式传 --user-data。`,
    );
  }
  const modelDir = resolve(takeFlag(args, "--model-dir") ?? process.env.VNOTE_MODEL_DIR ?? defaultModelDir(process.env.HOME ?? "."));
  // r54：Lab 默认绝不用共享缓存 —— QA 断言的是「第一次」，读别人的条目会让证据失效。
  const labCache = takeFlag(args, "--lab-cache") ?? "isolated";
  if (!["shared", "isolated", "cold"].includes(labCache)) {
    fail(`--lab-cache 只接受 shared|isolated|cold（收到：${labCache}）`);
  }
  rejectUnknownArgs(
    args,
    "verify.ts up [--port N] [--run ID] [--home DIR] [--user-data DIR] [--model-dir DIR] [--no-build] [--app PATH] [--min-path] [--empty-settings] [--lab-cache shared|isolated|cold] [--ready-timeout MS]",
  );
  // 端口先看清占用者（r58）：被别的应用占着就报错，上一轮自己的隧道就清掉。
  // 放在参数与 userData 边界之后、建目录/拉起 app 之前：被拒的 up 不留任何痕迹。
  await reservePort(port);
  // 目录一律放在所有拒绝之后：被拒的 up 不留下空 run 目录，同名 id 还能直接重跑
  mkdirSync(runDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(userData, { recursive: true });
  if (!emptySettings) {
    seedLocalRunConfig(userData);
    console.log(`config:   seeded ${PRIVATE_CONFIG_MAC} -> ${userData}/settings.json + secrets.bin (0600)`);
  }

  const buildLog = join(runDir, "build.log");
  if (!skipBuild) {
    process.stderr.write("verify: building apps/desktop …\n");
    const fd = openSync(buildLog, "w");
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: DESKTOP, stdout: fd, stderr: fd });
    if (build.exitCode !== 0) fail(`build failed (exit ${build.exitCode}); see ${buildLog}`);
  }

  // 端口占用在 reservePort 里已经判定过（监听者身份，而不只是 CDP 应答）
  try {
    await listTargets(port);
    fail(`port ${port} already has a CDP endpoint; choose another --port`);
  } catch {
    // expected: port is free
  }

  let electron: string;
  let appArgs: string[];
  let appPath: string | undefined;
  let electronBootstrap: string[] | undefined;
  if (appArg !== undefined) {
    appPath = resolve(appArg);
    electron = bundleExecutable(appPath);
    appArgs = [`--remote-debugging-port=${port}`];
  } else {
    // 新 worktree 的 `bun install` 不下载 electron 的 dist/：缺了就补跑 install.js（r58 验收 4）
    let resolved: ElectronBootstrapResult;
    try {
      resolved = ensureElectronBinary(REPO, DESKTOP);
    } catch (err) {
      fail(err instanceof ElectronBootstrapError ? err.message : String(err));
    }
    electron = resolved.binary;
    if (resolved.installed) {
      console.log(`electron: 缺 dist/，已补跑 ${resolved.steps.join(" → ")}`);
      electronBootstrap = resolved.steps;
    }
    // Lab 只在开发态存在：把模式显式传进去，绝不依赖「默认值恰好是 isolated」。
    appArgs = ["apps/desktop", `--remote-debugging-port=${port}`, `--lab-cache=${labCache}`];
  }

  const appLog = join(runDir, "app.log");
  const logFd = openSync(appLog, "w");
  const child = Bun.spawn([electron, ...appArgs], {
    cwd: REPO,
    env: {
      ...withoutLlmEnv(process.env),
      ...(minPath ? { PATH: LAUNCHD_PATH } : {}),
      VNOTE_HOME: home,
      VNOTE_USER_DATA: userData,
      VNOTE_MODEL_DIR: modelDir,
    },
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
  });
  child.unref();

  const state: RunState = {
    runId,
    runDir,
    port,
    pid: child.pid,
    home,
    userData,
    modelDir,
    appLog,
    ...(appPath !== undefined ? { appPath } : {}),
    commit: revParse(),
    startedAt: new Date().toISOString(),
    electron,
    ...(emptySettings ? {} : { configSeeded: true }),
    // 打包版没有 Lab，模式没有意义，不写进状态。
    ...(appArg === undefined ? { labCache } : {}),
    ...(electronBootstrap !== undefined ? { electronBootstrap } : {}),
  };

  let readyMs: number;
  try {
    readyMs = await waitUntilReady({
      port,
      home,
      timeoutMs: readyTimeout,
      win: false,
      // app 自己退了就别等满上限：日志里能看出是崩溃还是白屏
      guard: () => (alive(child.pid) ? null : `pid ${child.pid} 在就绪之前退出了（见 ${appLog}）`),
    });
  } catch (err) {
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
    const tail = existsSync(appLog) ? readFileSync(appLog, "utf8").split("\n").slice(-20).join("\n") : "";
    // 收尾：SIGTERM 宽限期后补 SIGKILL，连同子进程一起收（r58 验收 1）
    const stopped = await stopProcessTree(child.pid, { termMs: 4000, killMs: 3000 });
    const stuck = stopped.survivors.length > 0 ? `\n仍有进程收不掉：${stopped.survivors.join(",")}（kill -9 后手工清理）` : "";
    fail(`${err instanceof Error ? err.message : String(err)}\n收尾：${describeStop(stopped)}${stuck}\n--- app.log ---\n${tail}`);
  }
  console.log(`ready:    ${readyMs}ms（就绪即继续，未命中 ${readyTimeout}ms 上限）`);

  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
  try {
    writeLatestPointer(LATEST, runId);
  } catch (err) {
    // 检查与写指针之间 latest 被别的 up / 手工改成 run 目录：不覆盖，但别把刚起来的实例留成孤儿
    const stopped = await stopProcessTree(child.pid, { termMs: 4000, killMs: 3000 });
    fail(
      `${String(err)}\n已停掉本次启动的 pid ${child.pid}（${describeStop(stopped)}）；` +
        `证据在 ${runDir}（state.json 已写，down --run ${runId} 可收尾）。`,
    );
  }
  console.log(`run:      ${runDir}`);
  console.log(`port:     ${port}`);
  console.log(`pid:      ${child.pid}`);
  console.log(`home:     ${home}`);
  console.log(`userData: ${userData}`);
  console.log(`log:      ${appLog}`);
  if (appPath !== undefined) console.log(`app:      ${appPath}`);
}

/** up --target win-gamepc: install or reuse the Windows app, launch it in Session 1, tunnel CDP. */
async function upWin(args: string[], port: number, runId: string): Promise<void> {
  const sshHost = takeFlag(args, "--ssh-host") ?? WIN_SSH_HOST;
  const appFlag = takeFlag(args, "--app");
  const installerFlag = takeFlag(args, "--installer");
  const installDir = takeFlag(args, "--install-dir") ?? `${WIN_ROOT}\\app`;
  if (appFlag !== undefined && installerFlag !== undefined) fail("--app and --installer are mutually exclusive");
  if (appFlag !== undefined && !isWinPath(appFlag)) fail(`--app for win-gamepc needs a Windows path: ${appFlag}`);
  if (!isWinPath(installDir)) fail(`--install-dir for win-gamepc needs a Windows path: ${installDir}`);
  // a local installer is uploaded, a Windows path is assumed to be on the box already
  const uploadInstaller = installerFlag !== undefined && !isWinPath(installerFlag);
  if (uploadInstaller && !existsSync(installerFlag)) fail(`installer not found: ${installerFlag}`);
  const runDir = join(VERIFY_ROOT, runId);
  if (existsSync(runDir)) fail(`run already exists: ${runDir}`);
  const winDir = winLocal({ runDir });

  const remoteRunDir = `${WIN_RUNS}\\${runId}`;
  const remoteHome = takeFlag(args, "--home") ?? `${remoteRunDir}\\home`;
  const remoteUserDataArg = takeFlag(args, "--user-data");
  const remoteUserData = remoteUserDataArg ?? `${WIN_STATE_ROOT}\\${runId}\\user-data`;
  // 远端证据 staging 目录同样不许放 userData：那里面的东西会被 pull 到本地证据树。
  // 用归一化比较（分隔符、`.`/`..`、大小写），否则 D:/… 或 verify-state\..\verify\… 都能绕过去。
  if (winPathInside(WIN_RUNS, remoteUserData)) {
    fail(`--user-data 不能落在远端证据目录 ${WIN_RUNS} 内；默认位置是 ${WIN_STATE_ROOT}\\<run>\\user-data`);
  }
  const emptySettings = hasFlag(args, "--empty-settings");
  // Windows 安装版首启（NSIS 后第一次拉起）可能几十秒才开调试端口：默认给 180s，轮询重连
  const readyTimeout = readyTimeoutFlag(args, 180000);
  rejectUnknownArgs(
    args,
    "verify.ts up --target win-gamepc [--installer PATH | --app WINPATH] [--install-dir WINPATH] [--ssh-host NAME] [--ready-timeout MS]",
  );
  const remoteAppLog = `${remoteRunDir}\\app.log`;
  const remoteLaunch = `${remoteRunDir}\\launch.ps1`;
  const task = `VNoteVerify_${runId}`;
  const localAppLog = join(winDir, "app.log");
  let tunnelPid: number | undefined;
  /** 失败收尾要知道远端启动的是哪个 exe：声明在 try 之外，catch 里才用得上。 */
  let remoteApp: string | undefined;

  // 默认远端 userData 残留会让同名 run 直接继承旧凭据（--empty-settings 就不再是空的）
  if (remoteUserDataArg === undefined) {
    const exists = sshRun(sshHost, winPs(`if (Test-Path -LiteralPath '${remoteUserData}') { 'exists' } else { 'absent' }`)).stdout.trim();
    if (exists === "exists") {
      fail(
        `默认远端 userData 目录已存在：${remoteUserData}\n` +
          `同名 run 会复用它的 settings.json / secrets.bin。换一个 --run，或先在 ${sshHost} 上删除该目录。`,
      );
    }
  }

  // 本地端口同样先预检（r58）：CDP 隧道要绑它，别的应用/上一轮隧道占着就不能连
  await reservePort(port);
  // 目录一律放在所有拒绝之后：被拒的 up 不留下空 run 目录，同名 id 还能直接重跑
  mkdirSync(runDir, { recursive: true });
  try {
    sshRun(sshHost, winPs(`New-Item -ItemType Directory -Force -Path '${remoteRunDir}','${remoteHome}','${remoteUserData}' | Out-Null`));
    if (!emptySettings) {
      seedRemoteRunConfig(sshHost, remoteUserData);
      console.log(`config:   seeded %USERPROFILE%\\.config\\video-notes-verify\\llm.json -> ${remoteUserData}\\settings.json + secrets.bin (ACL: 当前用户)`);
    }

    let stateInstallDir: string | undefined;
    if (installerFlag !== undefined) {
      const remoteExe = uploadInstaller ? `${WIN_INSTALLER_DIR}\\${basename(installerFlag)}` : installerFlag;
      if (uploadInstaller) {
        process.stderr.write(`verify: uploading ${basename(installerFlag)} to ${sshHost}:${WIN_INSTALLER_DIR} …\n`);
        const scp = Bun.spawnSync(["scp", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", installerFlag, `${sshHost}:${WIN_INSTALLER_DIR}/`]);
        if (scp.exitCode !== 0) {
          const tail = scp.stderr.toString().split("\n").filter((line) => line.trim() !== "").slice(-5).join("\n");
          throw new RemoteError(`scp failed (exit ${scp.exitCode}): scp ${installerFlag} ${sshHost}:${WIN_INSTALLER_DIR}/\n${tail}`);
        }
      }
      // Stop any running Video Notes instance before NSIS overwrite so app.asar is never locked
      sshExec(
        sshHost,
        winPsEncoded(`Get-Process -Name 'Video Notes' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 400`),
      );
      // NSIS: /S is silent and /D= must be the last, unquoted argument (spaces inside are fine)
      sshRun(sshHost, winCmd(`start /wait "" "${remoteExe}" /S /D=${installDir}`));
      stateInstallDir = installDir;
      remoteApp = `${installDir}\\Video Notes.exe`;
    } else {
      remoteApp = appFlag ?? `${installDir}\\Video Notes.exe`;
    }
    // the install directory is part of the run record whenever it determined the executable
    if (stateInstallDir === undefined && appFlag === undefined) stateInstallDir = installDir;
    const appExists = sshRun(sshHost, winPs(`Test-Path -LiteralPath '${remoteApp}'`)).stdout.trim().toLowerCase();
    if (appExists !== "true") throw new RemoteError(`remote app missing on ${sshHost}: Test-Path -LiteralPath '${remoteApp}' said "${appExists}"`);

    // launch.ps1: no proxy for the app (the remote Surge answers 503 for localhost), and the
    // log stays in the run dir — a scheduled task's cwd is C:\Windows\System32. The script is
    // written as UTF-8 with BOM, because a non-ASCII install dir (Chinese + spaces) would be
    // garbled in a .cmd read by cmd.exe's OEM code page; the scheduled-task action below is
    // pure ASCII, so only the script carries the non-ASCII path.
    const script = [
      `Get-ChildItem env: | Where-Object { $_.Name -like 'VNOTE_LLM_*' -or $_.Name -like 'IDEALSOFT_*' } | Remove-Item`,
      `$env:NO_PROXY='*'`,
      `$env:no_proxy='*'`,
      `$env:HTTP_PROXY=''`,
      `$env:HTTPS_PROXY=''`,
      `$env:http_proxy=''`,
      `$env:https_proxy=''`,
      `$env:VNOTE_HOME='${remoteHome}'`,
      `$env:VNOTE_USER_DATA='${remoteUserData}'`,
      `$env:VNOTE_MODEL_DIR='${WIN_MODEL_DIR}'`,
      `& '${remoteApp}' --remote-debugging-port=${port} *>&1 | Out-File -FilePath '${remoteAppLog}' -Encoding utf8`,
    ].join("\r\n");
    const payload = Buffer.from(`${script}\r\n`, "utf8").toString("base64");
    sshRun(
      sshHost,
      // Use -EncodedCommand so Windows Defender never blocks command-line base64/WriteAllText on secondary up runs
      winPsEncoded(`[IO.File]::WriteAllText('${remoteLaunch}', [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')), (New-Object Text.UTF8Encoding $true))`),
    );

    // ssh lands in Session 0, which has no desktop: an interactive task starts the app in Session 1
    sshRun(sshHost, winCmd(`schtasks /Create /TN "${task}" /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${remoteLaunch}" /SC ONCE /ST 00:00 /IT /RL HIGHEST /F`));
    sshRun(sshHost, winCmd(`schtasks /Run /TN "${task}"`));

    // no -f: child.pid must be the tunnel itself, so `down` stops exactly that process
    const tunnel = Bun.spawn(
      [
        "ssh",
        "-N",
        "-L",
        `${port}:127.0.0.1:${port}`,
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        sshHost,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    tunnelPid = tunnel.pid;
    tunnel.unref();

    // 隧道刚起来时调试端口偶发连不上（Windows 安装版首启）：在 readyTimeout 内轮询重建
    // 连接，而不是一次性 fetch 判定。就绪即继续，超时报出端口、上限与远端日志路径。
    let readyMs: number;
    try {
      readyMs = await waitUntilReady({
        port,
        home: remoteHome,
        timeoutMs: readyTimeout,
        win: true,
        guard: () =>
          alive(tunnel.pid) ? null : `ssh 隧道在就绪前退出：ssh -N -L ${port}:127.0.0.1:${port} ${sshHost}（远端日志 ${remoteAppLog}）`,
      });
    } catch (err) {
      throw new RemoteError(
        `${err instanceof Error ? err.message : String(err)}\n远端日志：${remoteAppLog}\n` +
          `隧道：ssh -N -L ${port}:127.0.0.1:${port} ${sshHost}`,
      );
    }

    const pid = remoteMainPid(sshHost, remoteApp, port);
    console.log(`ready:    ${readyMs}ms（就绪即继续，未命中 ${readyTimeout}ms 上限）`);

    const state: RunState = {
      target: "win-gamepc",
      runId,
      runDir,
      port,
      pid,
      home: remoteHome,
      userData: remoteUserData,
      modelDir: WIN_MODEL_DIR,
      appLog: localAppLog,
      commit: revParse(),
      startedAt: new Date().toISOString(),
      electron: remoteApp,
      sshHost,
      remoteRunDir,
      remoteHome,
      remoteUserData,
      remoteModelDir: WIN_MODEL_DIR,
      remoteAppLog,
      remoteApp,
      ...(stateInstallDir !== undefined ? { installDir: stateInstallDir } : {}),
      sshTunnelPid: tunnelPid,
      scheduledTask: task,
      ...(emptySettings ? {} : { configSeeded: true }),
    };
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
    writeFileSync(join(winDir, "state.json"), JSON.stringify(state, null, 2));
    writeLatestPointer(LATEST, runId);
    console.log(`run:      ${runDir}`);
    console.log(`port:     ${port}`);
    console.log(`pid:      ${pid} (remote ${sshHost})`);
    console.log(`home:     ${remoteHome}`);
    console.log(`userData: ${remoteUserData}`);
    console.log(`log:      ${localAppLog} (pulled by down; remote ${remoteAppLog})`);
    console.log(`app:      ${remoteApp}`);
    console.log(`remote:   ${remoteRunDir}`);
    console.log(`tunnel:   ssh -N -L ${port}:127.0.0.1:${port} pid ${tunnelPid}`);
    console.log(`task:     ${task}`);
    // 远端 userData 不在 staging 里，但主动证明一次：拉回本地的东西里没有密钥。
    // 抛给外层 catch：此时远端 app、scheduled task 与 tunnel 都在，fail 会直接 exit 留下它们。
    const leaked = findSecretFiles(VERIFY_ROOT);
    if (leaked.length > 0) throw new RemoteError(secretsFailureMessage("up --target win-gamepc", leaked));
  } catch (err) {
    // no leftovers: the tunnel, the remote app, the task and both run dirs go away
    if (tunnelPid !== undefined) {
      // 隧道自己开的：SIGTERM 宽限期后补 SIGKILL，退出前证明它真的没了（r58 验收 6）
      const stopped = await stopProcessTree(tunnelPid, { termMs: 3000, killMs: 2000 });
      process.stderr.write(`verify: 收尾隧道——${describeStop(stopped)}\n`);
    }
    sshExec(sshHost, winCmd(`schtasks /End /TN "${task}"`));
    sshExec(sshHost, winCmd(`schtasks /Delete /TN "${task}" /F`));
    // schtasks /End 只结束 powershell 本身：app 已经起来时，它是 launch.ps1 的子进程，
    // 会带着调试端口活下来。按「这个 exe + 这个调试端口」精确收掉（r58 验收 1 的 win 侧）。
    const exeName = remoteApp === undefined ? undefined : (remoteApp.split(/[\\/]/).pop() ?? remoteApp);
    const strayFilter =
      exeName === undefined
        ? `$_.CommandLine -like '*--remote-debugging-port=${port}*'`
        : `$_.Name -eq '${exeName}' -and $_.CommandLine -like '*--remote-debugging-port=${port}*'`;
    const stray = sshExec(
      sshHost,
      winPsEncoded(
        `Get-CimInstance Win32_Process | Where-Object { ${strayFilter} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`,
      ),
    );
    const strayPids = stray.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    process.stderr.write(`verify: 收尾远端进程——${strayPids.length === 0 ? "没有残留" : `杀掉 ${strayPids.join(",")}`}\n`);
    sshExec(sshHost, winPs(`Remove-Item -LiteralPath '${remoteRunDir}' -Recurse -Force -ErrorAction SilentlyContinue`));
    // 默认远端 userData 是这次 up 自己建的（含 secrets.bin）：失败时一并清掉，
    // 否则远端留下一份密钥，同名 id 还会被“默认 userData 已存在”挡住
    if (remoteUserDataArg === undefined) {
      sshExec(sshHost, winPs(`Remove-Item -LiteralPath '${WIN_STATE_ROOT}\\${runId}' -Recurse -Force -ErrorAction SilentlyContinue`));
    }
    rmSync(runDir, { recursive: true, force: true });
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function doctor(args: string[]): Promise<void> {
  const targetFlag = takeFlag(args, "--target");
  const state = readState(takeFlag(args, "--run"));
  const win = resolveTarget(targetFlag, state) === "win-gamepc";
  rejectUnknownArgs(args, "verify.ts doctor [--run ID] [--target mac|win-gamepc]");
  const problems: string[] = [];
  const notes: string[] = [];
  const ok = (label: string) => console.log(`ok:   ${label}`);
  const warn = (label: string) => {
    console.log(`warn: ${label}`);
    notes.push(label);
  };
  const bad = (label: string) => {
    console.log(`fail: ${label}`);
    problems.push(label);
  };

  if (win) {
    const host = state.sshHost ?? WIN_SSH_HOST;
    remoteAlive(state)
      ? ok(`remote process ${state.pid} is alive on ${host}`)
      : bad(`remote process ${state.pid} is not running on ${host}`);
  } else {
    alive(state.pid) ? ok(`process ${state.pid} is alive (${processName(state.pid) || "unknown"})`) : bad(`process ${state.pid} is not running`);
  }

  let cdp: Cdp | undefined;
  try {
    cdp = await Cdp.open(state.port);
    ok(`CDP page present on port ${state.port}`);
  } catch (err) {
    bad(`CDP on port ${state.port}: ${String(err)}`);
  }

  if (cdp !== undefined) {
    try {
      const probeExpression = `Promise.all([
        Promise.resolve(document.title),
        window.vnote.settings(),
      ]).then(([title, s]) => ({
        title,
        notesRoot: s.notesRoot,
        appVersion: s.appVersion,
        modelsReady: s.models.ready,
        llmConfigured: s.llm.configured,
        ffmpeg: s.ffmpeg,
      }))`;
      type Probe = { title: string; notesRoot: string; appVersion: string; modelsReady: boolean; llmConfigured: boolean; ffmpeg: boolean };
      let probe = await cdp.eval<Probe>(probeExpression);
      // 启动后模型校验在后台跑；刚起来的一两秒 ready 还是 false，等它落定再判定。
      if (!probe.modelsReady) {
        const started = Date.now();
        while (Date.now() - started < 15000) {
          await sleep(250);
          probe = await cdp.eval<Probe>(probeExpression);
          if (probe.modelsReady) break;
        }
      }
      // win 的 notesRoot 由 app 自己拼：分隔符/大小写不敏感地比较（文档一直是这么写的）
      (win ? sameWinPath(probe.notesRoot, state.home) : probe.notesRoot === state.home)
        ? ok(`notes root is the isolated home (${probe.notesRoot})`)
        : bad(`notes root is ${probe.notesRoot}, expected ${state.home}`);
      const pkg = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")) as { version: string };
      probe.appVersion === pkg.version
        ? ok(`app version ${probe.appVersion} matches package.json`)
        : bad(`app version ${probe.appVersion} != package.json ${pkg.version}`);
      ok(`window title "${probe.title}"`);
      probe.ffmpeg ? ok("ffmpeg found") : warn("ffmpeg not found: extraction journeys cannot run");
      probe.modelsReady ? ok("local ASR models ready") : warn("local ASR models not ready: extraction journeys cannot run");
      probe.llmConfigured ? ok("LLM endpoint configured") : warn("LLM endpoint not configured: extraction journeys cannot run");
      // 顶层视口布局不变量（硬门禁）：.vn-shell / .vn-aside 恒等于 window.innerHeight（±2px）；
      // 任务浮层打开时 .vn-content 的底部留白必须盖住浮层本体（banner 高度 + 32，下限 240）。
      const layoutSample = await cdp.eval<{
        innerHeight: number;
        shellHeight: number;
        asideHeight: number;
        hasJob: boolean;
        bannerHeight: number;
        contentPaddingBottom: number;
      }>(
        `(() => {
          const shell = document.querySelector('.vn-shell');
          const aside = document.querySelector('.vn-aside');
          const content = document.querySelector('.vn-content');
          const banner = document.querySelector('[data-testid="job-banner"]');
          const cs = content ? getComputedStyle(content) : null;
          return {
            innerHeight: window.innerHeight,
            shellHeight: shell ? shell.getBoundingClientRect().height : -1,
            asideHeight: aside ? aside.getBoundingClientRect().height : -1,
            hasJob: banner !== null,
            bannerHeight: banner ? banner.getBoundingClientRect().height : -1,
            contentPaddingBottom: cs ? parseFloat(cs.paddingBottom) || 0 : 0,
          };
        })()`,
      );
      const viewportIssues = viewportProblems(layoutSample);
      for (const problem of viewportIssues) bad(`viewport invariant: ${problem}`);
      if (viewportIssues.length === 0) {
        ok(
          `viewport invariant: .vn-shell ${layoutSample.shellHeight}px == innerHeight ${layoutSample.innerHeight}px, ` +
            `.vn-aside ${layoutSample.asideHeight}px`,
        );
      }
      const overlayIssues = jobPaddingProblems(layoutSample);
      for (const problem of overlayIssues) bad(`job overlay: ${problem}`);
      if (overlayIssues.length === 0) {
        ok(
          layoutSample.hasJob
            ? `job overlay: banner ${Math.ceil(layoutSample.bannerHeight)}px, .vn-content padding-bottom ${layoutSample.contentPaddingBottom}px`
            : "job overlay: no active job, bottom inset not required",
        );
      }
    } catch (err) {
      bad(`renderer probe failed: ${String(err)}`);
    } finally {
      cdp.close();
    }
  }

  if (win) {
    const host = state.sshHost ?? WIN_SSH_HOST;
    const probe = winPs(`Get-NetTCPConnection -LocalPort ${state.port} -State Listen`);
    const listen = sshExec(host, probe);
    if (listen.code === 0 && listen.stdout.trim() !== "") {
      ok(`remote 127.0.0.1:${state.port} is listening on ${host}`);
    } else {
      const tail = stderrTail(listen);
      bad(`remote 127.0.0.1:${state.port} is not listening on ${host} (exit ${listen.code}): ${probe}${tail === "" ? "" : `\n${tail}`}`);
    }
  } else {
    const probe = inspectPort(state.port);
    const conflict = portConflict(probe);
    if (conflict?.kind === "stale-tunnels") {
      // 这个端口上只剩隧道：多半是上一轮没收尾的（例如 10 月 29 日留在 9416 的 PID 62495）
      warn(
        `port ${state.port} 上还有上一轮残留的 ssh 隧道（${describeListeners(
          probe.listeners.filter((entry) => probe.tunnels.includes(entry.pid)),
        )}）；用 \`verify.ts tunnels --kill\` 或下一次 up 清掉`,
      );
    } else if (conflict?.kind === "foreign-tunnel") {
      const pid = conflict.owners[0]?.pid;
      warn(
        `port ${state.port} 上有一条 ssh 隧道但不是 CDP 形状（${describeListeners(conflict.owners)}）；` +
          `确认是残留后用 \`verify.ts tunnels --kill --pid ${pid ?? "<pid>"}\` 清掉`,
      );
    } else if (probe.listeners.length === 0) {
      warn(`lsof reports no listener on ${state.port}`);
    } else if (probe.listeners.some((entry) => entry.pid === state.pid)) {
      ok(`port ${state.port} is owned by pid ${state.pid}`);
    } else {
      bad(`port ${state.port} is owned by ${describeListeners(probe.listeners)}, not ${state.pid}`);
    }
  }

  if (win) {
    ok(`remote app ${state.remoteApp ?? "(unrecorded)"} on ${state.sshHost ?? WIN_SSH_HOST}; build freshness is not checked over ssh`);
  } else if (state.appPath !== undefined) {
    const stamp = statSync(state.appPath).mtimeMs;
    stamp > newestSourceMtime()
      ? ok(`packaged app is newer than apps/desktop + packages/core sources (${state.appPath})`)
      : bad(`packaged app at ${state.appPath} is older than sources; rerun \`bun run package:mac\``);
  } else {
    const newest = newestSourceMtime();
    const stale = OUTPUTS.filter((path) => !existsSync(path) || statSync(path).mtimeMs < newest);
    stale.length === 0
      ? ok("build output is newer than apps/desktop + packages/core sources")
      : bad(`stale build: ${stale.map((p) => p.replace(`${REPO}/`, "")).join(", ")} older than sources`);
  }

  const secretFiles = findSecretFiles(VERIFY_ROOT);
  secretFiles.length === 0
    ? ok(`no secrets.* files under ${VERIFY_ROOT}`)
    : bad(`证据目录里有 ${secretFiles.length} 个密钥文件：${secretFiles.map((path) => path.replace(`${REPO}/`, "")).join(", ")}`);

  if (problems.length > 0) {
    console.log(`\ndoctor: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`\ndoctor: healthy${notes.length > 0 ? ` (${notes.length} warning(s))` : ""}`);
}

async function drive(args: string[]): Promise<void> {
  const action = args.shift();
  if (action === undefined) fail("drive needs an action (eval|click|type|fill|press|drop|wait|text|clipboard|shot|snapshot|status|log)");
  const targetFlag = takeFlag(args, "--target");
  const state = readState(takeFlag(args, "--run"));
  const win = resolveTarget(targetFlag, state) === "win-gamepc";
  // a win run's pid is remote, so the local process table says nothing about it
  if (win ? !remoteAlive(state) : !alive(state.pid)) fail(`run ${state.runId} is not running; start a new run with \`up\``);
  const cdp = await Cdp.open(state.port);
  try {
    switch (action) {
      case "eval": {
        const expr = args.join(" ");
        if (expr === "") fail("eval needs an expression");
        console.log(JSON.stringify(await cdp.eval(expr), null, 2));
        break;
      }
      case "click": {
        const index = Number(takeFlag(args, "--index") ?? "0");
        const selector = args[0];
        if (selector === undefined) fail("click needs a selector");
        await click(cdp, selector, index);
        console.log(`clicked ${selector}[${index}]`);
        break;
      }
      case "click-text": {
        const text = args.join(" ");
        if (text === "") fail("click-text needs a label");
        const index = Number(takeFlag(args, "--index") ?? "0");
        await cdp.send("Accessibility.enable");
        await cdp.send("DOM.enable");
        let node: { backendDOMNodeId?: number; name?: { value?: string } } | undefined;
        const started = Date.now();
        while (Date.now() - started < 5000) {
          const { nodes } = await cdp.send<{ nodes: Array<{ ignored?: boolean; role?: { value?: string }; name?: { value?: string }; backendDOMNodeId?: number }> }>(
            "Accessibility.getFullAXTree",
          );
          const candidates = nodes.filter(
            (n) =>
              n.ignored !== true &&
              n.backendDOMNodeId !== undefined &&
              (n.role?.value === "button" || n.role?.value === "checkbox" || n.role?.value === "tab" || n.role?.value === "link"),
          );
          const exact = candidates.filter((n) => n.name?.value === text);
          node =
            exact.length > 0
              ? exact[index]
              : candidates.filter((n) => (n.name?.value ?? "").replace(/^\d+\s+/, "") === text)[index];
          if (node !== undefined) break;
          await sleep(100);
        }
        if (node?.backendDOMNodeId === undefined) fail(`no button, checkbox, tab or link named ${JSON.stringify(text)}`);
        await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendDOMNodeId });
        const box = await cdp.send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId });
        const q = box.model.content;
        const x = (q[0]! + q[2]! + q[4]! + q[6]!) / 4;
        const y = (q[1]! + q[3]! + q[5]! + q[7]!) / 4;
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        console.log(`clicked ${JSON.stringify(text)}[${index}]`);
        break;
      }
      case "type": {
        const text = args.join(" ");
        await type(cdp, text);
        console.log(`typed ${JSON.stringify(text)}`);
        break;
      }
      case "fill": {
        const selector = args[0];
        const text = args.slice(1).join(" ");
        if (selector === undefined) fail("fill needs a selector");
        await fill(cdp, selector, text);
        console.log(`filled ${selector} with ${JSON.stringify(text)}`);
        break;
      }
      case "press": {
        const key = args[0];
        if (key === undefined) fail("press needs a key");
        const modifiers = hasFlag(args, "--meta") ? 4 : 0;
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, modifiers });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers });
        console.log(`pressed ${key}`);
        break;
      }
      case "drop": {
        const dropSelector = takeFlag(args, "--selector") ?? "[data-testid=dropzone]";
        const file = args[0];
        if (file === undefined) fail("drop needs a file path");
        if (win) {
          let winPath: string;
          try {
            winPath = winDropPath(state.sshHost ?? WIN_SSH_HOST, file);
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
          }
          await drop(cdp, file, dropSelector, winPath);
          console.log(`dropped ${winPath} on ${dropSelector}`);
          break;
        }
        await drop(cdp, file, dropSelector);
        console.log(`dropped ${resolve(file)} on ${dropSelector}`);
        break;
      }
      case "drag": {
        const index = Number(takeFlag(args, "--index") ?? "0");
        const steps = Number(takeFlag(args, "--steps") ?? "8");
        const selector = args[0];
        const dx = Number(args[1]);
        const dy = Number(args[2]);
        if (selector === undefined) fail("drag needs a selector");
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) fail("drag needs numeric dx and dy");
        if (!Number.isFinite(steps) || steps < 1) fail("--steps must be a positive integer");
        await drag(cdp, selector, index, dx, dy, Math.round(steps));
        break;
      }
      case "wait": {
        const timeout = Number(takeFlag(args, "--timeout") ?? "20000");
        const expr = args.join(" ");
        if (expr === "") fail("wait needs an expression");
        await waitFor(cdp, expr, timeout);
        console.log(`condition met: ${expr}`);
        break;
      }
      case "text": {
        console.log(await cdp.eval<string>("document.body.innerText"));
        break;
      }
      case "clipboard": {
        // mac reads its own clipboard. A Windows clipboard belongs to the interactive session,
        // and ssh exec lives in Session 0 — Get-Clipboard over ssh sees an empty clipboard, so
        // the app's renderer is the only reader of what the UI actually copied (r41, measured).
        let text: string | undefined;
        if (win) {
          try {
            await cdp.send("Page.bringToFront");
            text = await cdp.eval<string>("navigator.clipboard.readText()");
          } catch (err) {
            fail(`cannot read the Windows clipboard through the renderer: ${String(err)}`);
          }
        } else {
          text = Bun.spawnSync(["pbpaste"]).stdout.toString();
        }
        if (text === undefined) fail("clipboard read returned nothing");
        // printed first so `verify.ts drive clipboard | rg …` still works
        console.log(text);
        const file = takeFlag(args, "--save") ?? join(win ? winLocal(state) : state.runDir, "clipboard.txt");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
        console.log(`clipboard: ${file} (${text.length} chars)`);
        break;
      }
      case "shot": {
        const name = args[0] ?? `shot-${stamp()}`;
        const file = join(win ? winLocal(state) : state.runDir, `${name}.png`);
        const res = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
        writeFileSync(file, Buffer.from(res.data, "base64"));
        console.log(`screenshot: ${file}`);
        break;
      }
      case "snapshot": {
        const name = args[0] ?? `snapshot-${stamp()}`;
        const file = join(win ? winLocal(state) : state.runDir, `${name}.aria.txt`);
        const lines = await writeAxTree(cdp, file);
        console.log(`accessibility snapshot: ${file} (${lines} lines)`);
        break;
      }
      case "status": {
        const status = await cdp.eval(`Promise.all([window.vnote.listLibrary(), window.vnote.activeJob(), window.vnote.settings()]).then(([library, job, s]) => ({
          library: library.map((v) => ({ id: v.id, title: v.title, status: v.status, topics: v.topicCount, clips: v.clipCount, outputDir: v.outputDir })),
          job: job === null ? null : { id: job.jobId, kind: job.kind, state: job.state, step: job.step, done: job.done, total: job.total, detail: job.detail, error: job.error },
          settings: { notesRoot: s.notesRoot, modelDir: s.modelDir, cacheRoot: s.cacheRoot, appVersion: s.appVersion, modelsReady: s.models.ready, llmConfigured: s.llm.configured, ffmpeg: s.ffmpeg },
        }))`);
        console.log(JSON.stringify(status, null, 2));
        break;
      }
      case "log": {
        const lines = Number(args[0] ?? "40");
        if (win) {
          const host = state.sshHost ?? WIN_SSH_HOST;
          const remote = state.remoteAppLog;
          if (remote === undefined) fail("state.json has no remoteAppLog; rerun `up --target win-gamepc`");
          const remoteRunDir = state.remoteRunDir ?? `${WIN_RUNS}\\${state.runId}`;
          const remoteHome = state.remoteHome ?? `${remoteRunDir}\\home`;
          const logDir = `${remoteHome}\\logs`;
          const app = sshExec(host, winPs(`Get-Content -LiteralPath '${remote}' -Tail ${lines} -ErrorAction SilentlyContinue`));
          const structured = sshExec(
            host,
            winPs(`Get-ChildItem -LiteralPath '${logDir}' -File | Sort-Object Name | Get-Content -Tail ${lines} -ErrorAction SilentlyContinue`),
          );
          // stdout first, then <remoteHome>\logs\*.log in name order: the last <lines> of both
          const combined = [app.stdout, structured.stdout]
            .map((text) => text.replace(/\r\n/g, "\n").replace(/\n+$/, ""))
            .filter((text) => text !== "")
            .join("\n")
            .split("\n");
          console.log(combined.slice(-lines).join("\n"));
          break;
        }
        const text = existsSync(state.appLog) ? readFileSync(state.appLog, "utf8").split("\n") : [];
        console.log(text.slice(-lines).join("\n"));
        break;
      }
      default:
        fail(`unknown drive action: ${action}`);
    }
  } finally {
    cdp.close();
  }
}

async function down(args: string[]): Promise<void> {
  const purge = hasFlag(args, "--purge");
  const targetFlag = takeFlag(args, "--target");
  const state = readState(takeFlag(args, "--run"));
  rejectUnknownArgs(args, "verify.ts down [--run ID] [--purge] [--target mac|win-gamepc]");
  if (resolveTarget(targetFlag, state) === "win-gamepc") {
    await downWin(state, purge);
    return;
  }
  if (alive(state.pid)) {
    const name = processName(state.pid);
    // a packaged run's process is the bundle executable ("Video Notes"), not "Electron"
    const expected = state.appPath === undefined ? "Electron" : basename(bundleExecutable(state.appPath));
    if (!name.toLowerCase().includes(expected.toLowerCase())) {
      fail(`refusing to kill pid ${state.pid}: process name is "${name}", not ${expected}`);
    }
    // 同一棵进程树：主进程收掉后渲染进程/helper 也要收，SIGTERM 不行就补 SIGKILL
    const stopped = await stopProcessTree(state.pid, { termMs: 8000, killMs: 3000 });
    console.log(`stopped ${describeStop(stopped)}`);
    if (stopped.survivors.length > 0) fail(`pid ${state.pid} did not exit：${stopped.survivors.join(",")}`);
  } else {
    console.log(`pid ${state.pid} is already gone`);
  }
  state.stoppedAt = new Date().toISOString();
  writeFileSync(join(state.runDir, "state.json"), JSON.stringify(state, null, 2));

  // Prune only the renderer's space-consuming runtime caches. Evidence and small
  // operator artifacts (png, aria.txt, logs, trajectory.json, topic.md, …) are kept.
  const prune = (path: string, label: string) => {
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
      console.log(`pruned ${label}`);
    }
  };
  prune(join(state.runDir, "home/.cache"), "home/.cache");
  // userData 现在在证据目录之外（r50），缓存要按 state.json 记录的真实路径剪
  for (const name of ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "ShaderCache", "GrShaderCache", "Partitions"]) {
    prune(join(state.userData, name), `userData/${name}`);
  }
  // Local Storage is pruned only when it holds no evidence.
  const localStore = join(state.userData, "Local Storage");
  if (existsSync(localStore) && readdirSync(localStore).length === 0) {
    rmSync(localStore, { recursive: true, force: true });
    console.log(`pruned userData/Local Storage`);
  }

  reportKept(state.runDir, purge);
  // purge 也清掉这个 run 的默认 userData 目录：留着会让同名 run 复用旧 settings/secrets
  if (purge && resolve(state.userData) === join(VERIFY_STATE_ROOT, state.runId, "user-data")) {
    rmSync(join(VERIFY_STATE_ROOT, state.runId), { recursive: true, force: true });
    console.log(`purged ${join(VERIFY_STATE_ROOT, state.runId)}`);
  }
  assertNoSecretsInEvidence("down");
}

/** The tail every `down` shares: purge the run dir or report what stayed in `evidenceDir`. */
function reportKept(runDir: string, purge: boolean, evidenceDir: string = runDir): void {
  if (purge) {
    rmSync(runDir, { recursive: true, force: true });
    // a pointer at a deleted run would make the next bare `drive`/`doctor` read a missing state.json
    if (readLatestPointer(LATEST) === basename(runDir)) rmSync(LATEST, { recursive: true, force: true });
    console.log(`purged ${runDir}; the evidence is gone`);
    return;
  }
  const kept = readdirSync(evidenceDir);
  const pngCount = kept.filter((n) => n.endsWith(".png")).length;
  const ariaCount = kept.filter((n) => n.endsWith(".aria.txt")).length;
  console.log(`kept ${pngCount} png, ${ariaCount} aria.txt, ${evidenceDir}`);
}

/** down --target win-gamepc: stop the tunnel and the remote app, then pull the evidence. */
async function downWin(state: RunState, purge: boolean): Promise<void> {
  const host = state.sshHost ?? WIN_SSH_HOST;
  const remoteRunDir = state.remoteRunDir ?? `${WIN_RUNS}\\${state.runId}`;
  try {
    if (state.sshTunnelPid !== undefined) {
      // pid 复用保护：只杀确实是 ssh 的那个 pid（state.json 可能早已陈旧）
      const tunnelName = processName(state.sshTunnelPid);
      if (tunnelName === "") {
        console.log(`ssh tunnel pid ${state.sshTunnelPid} 已经不在`);
      } else if (!tunnelName.toLowerCase().includes("ssh")) {
        fail(`refusing to kill pid ${state.sshTunnelPid}: 进程名是 "${tunnelName}"，不是 ssh（state.json 陈旧、pid 已被复用）`);
      } else {
        // 验证脚本自己开的隧道必须真的关掉（r58 验收 6）：SIGTERM 宽限期后补 SIGKILL
        const stopped = await stopProcessTree(state.sshTunnelPid, { termMs: 3000, killMs: 2000 });
        console.log(`ssh tunnel: ${describeStop(stopped)}`);
        if (stopped.survivors.length > 0) fail(`ssh 隧道 pid ${state.sshTunnelPid} 收不掉：先 kill -9 ${state.sshTunnelPid}`);
      }
    } else {
      console.log("no sshTunnelPid recorded; nothing to stop locally");
    }

    // 远端 pid 同样先核身份：陈旧 state.json 的 pid 可能已经分给了别的进程
    const expectedExe = (state.remoteApp ?? "Video Notes.exe").split(/[\\/]/).pop() ?? "Video Notes.exe";
    const expectedName = expectedExe.toLowerCase().endsWith(".exe") ? expectedExe.slice(0, -4) : expectedExe;
    const remoteName = sshExec(host, winPs(`(Get-Process -Id ${state.pid} -ErrorAction SilentlyContinue).ProcessName`)).stdout.trim();
    if (remoteName !== "" && remoteName.toLowerCase() !== expectedName.toLowerCase()) {
      fail(`refusing to kill remote pid ${state.pid}: 远端进程名是 "${remoteName}"，不是 "${expectedName}"（state.json 陈旧、pid 已被复用）`);
    }

    // /T takes the renderer and helper children with the main process
    const kill = sshExec(host, winCmd(`taskkill /PID ${state.pid} /T /F`));
    if (kill.code !== 0) console.log(`taskkill reported exit ${kill.code}: ${stderrTail(kill)}`);
    const started = Date.now();
    while (Date.now() - started < 8000 && remoteAlive(state)) await sleep(250);
    if (remoteAlive(state)) {
      const probe = winPs(`Get-Process -Id ${state.pid}`);
      throw new RemoteError(`remote pid ${state.pid} is still running on ${host}: ${probe}`);
    }
    console.log(`stopped remote pid ${state.pid}`);

    if (state.scheduledTask !== undefined) {
      const del = sshExec(host, winCmd(`schtasks /Delete /TN "${state.scheduledTask}" /F`));
      del.code === 0
        ? console.log(`deleted scheduled task ${state.scheduledTask}`)
        : console.log(`schtasks /Delete reported exit ${del.code}: ${stderrTail(del)}`);
    }

    const defaultWinInstallDir = `${WIN_ROOT}\\app`;
    if (state.installDir !== undefined && state.installDir.toLowerCase() !== defaultWinInstallDir.toLowerCase()) {
      sshExec(
        host,
        winPsEncoded(`
          $targetExe = '${defaultWinInstallDir}\\Video Notes.exe'
          if (Test-Path -LiteralPath $targetExe) {
            $wsh = New-Object -ComObject WScript.Shell
            foreach ($lnk in @((Join-Path $env:USERPROFILE 'Desktop\\Video Notes.lnk'), (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Video Notes.lnk'))) {
              $sc = $wsh.CreateShortcut($lnk)
              $sc.TargetPath = $targetExe
              $sc.WorkingDirectory = '${defaultWinInstallDir}'
              $sc.Save()
            }
          }
        `),
      );
      console.log(`restored Windows shortcuts to ${defaultWinInstallDir}\\Video Notes.exe`);
    }

    // Prune only the space-consuming remote caches; evidence and small operator artifacts stay.
    const remoteUserData = state.remoteUserData ?? `${WIN_STATE_ROOT}\\${state.runId}\\user-data`;
    const remoteCaches = [
      `${remoteRunDir}\\home\\.cache`,
      ...["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "ShaderCache", "GrShaderCache", "Partitions"].map(
        (name) => `${remoteUserData}\\${name}`,
      ),
    ];
    sshExec(host, winPs(`${remoteCaches.map((path) => `'${path}'`).join(",")} | ForEach-Object { Remove-Item -LiteralPath $_ -Recurse -Force -ErrorAction SilentlyContinue }`));
    console.log(`pruned ${remoteCaches.length} remote cache paths`);

    const winDir = winLocal(state);
    // 清单即契约（r58 验收 5）：远端 run 目录下除了缓存都是证据，逐个拉、逐个核对大小；
    // 漏的补拉一次，仍然缺就报错，而不是像以前那样只按文件名白名单拉。
    // 用 -EncodedCommand：清单里的插值字符串带双引号，放进 winPs 的 -Command "…" 会破引号边界。
    const listing = sshRun(
      host,
      winPsEncoded(
        `Get-ChildItem -LiteralPath '${remoteRunDir}' -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Length)\`t$($_.FullName)" }`,
      ),
    ).stdout;
    const inventory = evidenceInventory(parseRemoteListing(listing), remoteRunDir);
    const expected = inventory.expected;
    const localPathOf = (remotePath: string) => join(winDir, ...relativeEvidencePath(remotePath, remoteRunDir));
    const pullOne = (remotePath: string): boolean => pullRemoteFile(host, remotePath, localPathOf(remotePath));
    const localBytes = (remotePath: string): number | null => {
      const path = localPathOf(remotePath);
      return existsSync(path) ? statSync(path).size : null;
    };
    if (inventory.skipped.length > 0) {
      console.log(
        `evidence: ${inventory.skipped.length} 个大体积媒体不拉取（派生件，源文件可复现）：` +
          inventory.skipped.map((file) => `${file.path.replace(`${remoteRunDir}\\`, "")} ${file.bytes}B`).join(", "),
      );
    }

    const failures = expected.filter((file) => !pullOne(file.path)).length;
    let gaps = evidenceGaps(expected, localBytes);
    if (gaps.length > 0) {
      // 一次重试：ssh 偶发断流不该让一份证据永久缺失
      for (const gap of gaps) pullOne(gap.path);
      gaps = evidenceGaps(expected, localBytes);
    }
    if (gaps.length > 0) {
      throw new RemoteError(
        `证据清单没拉齐（${gaps.length}/${expected.length}，首次拉取失败 ${failures} 个）：\n${gaps.map((gap) => `  ${describeGap(gap)}`).join("\n")}\n` +
          `远端清单来自 ${remoteRunDir}；补拉后可重跑 down，或手工 scp 后核对大小。`,
      );
    }
    console.log(`evidence: ${expected.length} 个远端证据文件全部拉齐并核对大小（缓存已排除）-> ${winDir}`);
    // 清单本身也是证据：应拉取/已跳过（大媒体）/不拉取（缓存）三份列表都落盘
    writeFileSync(
      join(winDir, "evidence-inventory.json"),
      `${JSON.stringify(
        {
          remoteRunDir,
          expected: expected.map((file) => ({ path: file.path, bytes: file.bytes })),
          skippedMedia: inventory.skipped.map((file) => ({ path: file.path, bytes: file.bytes })),
          excluded: parseRemoteListing(listing)
            .filter((file) => !expected.includes(file) && !inventory.skipped.includes(file))
            .map((file) => file.path),
        },
        null,
        2,
      )}\n`,
    );

    state.stoppedAt = new Date().toISOString();
    writeFileSync(join(state.runDir, "state.json"), JSON.stringify(state, null, 2));
    writeFileSync(join(winDir, "state.json"), JSON.stringify(state, null, 2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  // the remote run dir is staging for the pull: keep it by default, drop it with the local purge
  if (purge) {
    const dropped = sshExec(host, winPs(`Remove-Item -LiteralPath '${remoteRunDir}' -Recurse -Force -ErrorAction SilentlyContinue`));
    console.log(dropped.code === 0 ? `purged ${remoteRunDir} on ${host}` : `could not purge ${remoteRunDir} on ${host}: ${stderrTail(dropped)}`);
    // 默认远端 userData 目录一并清掉：留着会让同名 run 复用旧 settings/secrets
    const defaultState = `${WIN_STATE_ROOT}\\${state.runId}`;
    if ((state.remoteUserData ?? "").toLowerCase() === `${defaultState}\\user-data`.toLowerCase()) {
      const stateDropped = sshExec(host, winPs(`Remove-Item -LiteralPath '${defaultState}' -Recurse -Force -ErrorAction SilentlyContinue`));
      console.log(stateDropped.code === 0 ? `purged ${defaultState} on ${host}` : `could not purge ${defaultState} on ${host}: ${stderrTail(stateDropped)}`);
    }
  }
  // the proof for a win run lives in win/, not next to state.json
  reportKept(state.runDir, purge, purge ? state.runDir : winLocal(state));
  assertNoSecretsInEvidence("down --target win-gamepc");
}

function runs(): void {
  if (!existsSync(VERIFY_ROOT)) {
    console.log("no runs yet");
    return;
  }
  for (const entry of readdirSync(VERIFY_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const stateFile = join(VERIFY_ROOT, entry.name, "state.json");
    if (!existsSync(stateFile)) continue;
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
    // a win run's pid is remote: ask the box instead of the local process table
    const running = state.target === "win-gamepc" ? remoteAlive(state) : alive(state.pid);
    console.log(`${entry.name}  port=${state.port}  pid=${state.pid}  ${running ? "running" : "stopped"}`);
  }
}

/**
 * 列出本机的 ssh -L 隧道（含本 harness 的 CDP 形状），带端口、形状与记录它的 run。
 *
 * `--kill` 只清「CDP 形状 + 没有活跃 run 记录」的残留；有活跃 owner 的隧道、以及形状
 * 不符的普通 ssh 转发（例如 `-L 5432:127.0.0.1:5432 db-host`）一律不动，必须用
 * `--pid <pid>` 显式点名——列举候选不等于授权杀掉整机所有 SSH 会话。
 */
async function tunnels(args: string[]): Promise<void> {
  const kill = hasFlag(args, "--kill");
  const pidRaw = takeFlag(args, "--pid");
  rejectUnknownArgs(args, "verify.ts tunnels [--kill [--pid PID]]");
  const pid = pidRaw === undefined ? undefined : Number(pidRaw);
  if (pidRaw !== undefined && (!Number.isInteger(pid) || (pid ?? 0) <= 0)) fail(`--pid 必须是正整数（收到 ${JSON.stringify(pidRaw)}）`);
  const found = tunnelsOf(processList());
  if (found.length === 0) {
    console.log("本机没有 ssh -L 隧道");
    return;
  }
  const selected = pid === undefined ? found : found.filter((entry) => entry.pid === pid);
  if (pid !== undefined && selected.length === 0) {
    fail(`没有记录到 ssh 隧道 pid ${pid}；当前隧道：${found.map((entry) => entry.pid).join(", ")}`);
  }
  for (const entry of found) {
    const owner = tunnelOwner(entry.pid);
    const shape = entry.cdpShape ? "CDP 形状" : "非 CDP 形状";
    const ownership = owner === null ? "残留（没有 run 记录它）" : owner.live ? `活跃 run ${owner.runId}` : `run ${owner.runId} 已收尾`;
    console.log(`tunnel:   pid ${entry.pid}  port ${entry.port}  ${shape}  ${ownership}`);
    console.log(`  ${entry.command}`);
  }
  if (!kill) {
    console.log("\n清理：verify.ts tunnels --kill（只清 CDP 形状残留）或 tunnels --kill --pid <pid>（显式点名）");
    return;
  }
  const refused: number[] = [];
  for (const entry of selected) {
    const owner = tunnelOwner(entry.pid);
    // 不带 --pid 时只清「残留 + CDP 形状」；显式点名则按操作者的决定执行
    if (pid === undefined && (owner?.live === true || !entry.cdpShape)) {
      refused.push(entry.pid);
      continue;
    }
    const stopped = await stopProcessTree(entry.pid, { termMs: 3000, killMs: 2000 });
    console.log(`stopped   ${describeStop(stopped)}`);
    if (stopped.survivors.length > 0) fail(`隧道 pid ${entry.pid} 收不掉：kill -9 ${entry.pid}`);
  }
  if (refused.length > 0) {
    console.log(`\n未清理 ${refused.join(", ")}：有活跃 run 记录它，或不是 CDP 形状的 ssh 转发。`);
    console.log("确认确实要清时显式点名：verify.ts tunnels --kill --pid <pid>");
  }
}

// ------------------------------------------------------- impeccable 门禁（detect / prototype）


function slugOf(root: string): string {
  const manifest = join(root, "package.json");
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (parsed.name) return parsed.name;
    } catch {
      // 坏的 package.json 是项目的问题，不是本命令的问题：退回目录名
    }
  }
  return basename(root);
}

/** 把事件追加到 <runDir>/verify-events.jsonl；runDir 不存在时跳过记录。 */
function appendVerifyEvent(runDir: string | undefined, kind: string, action: string, ok: boolean, detail: string, evidence?: string): void {
  if (!runDir || !existsSync(runDir)) return;
  const entry: Record<string, unknown> = { at: new Date().toISOString(), kind, action, ok, detail };
  if (evidence) entry.evidence = evidence;
  writeFileSync(join(runDir, "verify-events.jsonl"), `${JSON.stringify(entry)}\n`, { flag: "a" });
}
/** 非致命版 readState：run 不存在时返回 null（prototype 的 round 模式允许没有 run；freeze 模式要求有 run 以拿 CDP 会话）。 */
function tryReadState(runId?: string): RunState | null {
  const id = checkedRunId(runId);
  if (id === null) return null;
  const file = join(VERIFY_ROOT, id, "state.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RunState) : null;
}

interface DetectResult {
  runId: string;
  targets: string[];
  findings: ImpeccableFinding[];
  primary: ImpeccableFinding[];
  advisory: ImpeccableFinding[];
  reportPath: string;
  /** CI 且本机无二进制时记 skip；此时不写报告、不计门禁。 */
  skipped: boolean;
}

/**
 * detect 的主体：静态扫 apps/desktop/src/renderer/src（绝不扫仓库根、绝不扫 tmp/），
 * 非 --source-only 时再用 CDP 探活并做实时扫描（live run 存在却扫不到 = 门禁失效，计入失败；
 * 没有任何 run 时实时扫描只记 warn 并跳过）。结果合并去重后写报告。
 */
async function runDetect(state: RunState | null, options: { target: "mac" | "win-gamepc"; sourceOnly: boolean }): Promise<DetectResult> {
  const runId = state?.runId ?? "(no run)";
  const staticTarget = "apps/desktop/src/renderer/src";
  const targets: string[] = [staticTarget];
  const reportPath =
    state !== null && existsSync(state.runDir)
      ? join(state.runDir, "impeccable-report.json")
      : join(VERIFY_ROOT, "latest-impeccable-report.json");
  const binary = resolveImpeccableBin();
  if (binary === null) {
    if (process.env.CI === "true") {
      console.log("skipped: impeccable not installed (CI)");
      return { runId, targets, findings: [], primary: [], advisory: [], reportPath, skipped: true };
    }
    fail("impeccable detect is mandatory on a dev/verify machine but no binary was found; install it or set IMPECCABLE_BIN");
  }
  const all: ImpeccableFinding[] = [];

  const runScan = (label: string, scanArgs: string[]): void => {
    const run = runImpeccable(binary, scanArgs, REPO);
    let findings: ImpeccableFinding[];
    try {
      findings = parseFindings(run.stdout);
    } catch (err) {
      fail(`${label}: ${String(err)}; stderr: ${run.stderr.trim().split("\n").slice(-3).join(" | ")}`);
    }
    if (findings.length === 0 && run.exitStatus !== 0) {
      fail(`${label}: exit ${run.exitStatus} with no findings; stderr: ${run.stderr.trim().split("\n").slice(-3).join(" | ")}`);
    }
    all.push(...findings);
  };

  runScan("static scan", ["detect", staticTarget, "--json"]);

  if (!options.sourceOnly) {
    if (state === null) {
      console.log("warn: no verification run (no state.json): live CDP scan skipped, source-only findings stand");
    } else {
      let cdp: Cdp | undefined;
      try {
        cdp = await Cdp.open(state.port);
        runScan("CDP scan", ["detect", "--cdp", String(state.port), "--json"]);
      } catch (err) {
        fail(`CDP scan: no live page answer on port ${state.port} (${String(err)}); a live run that cannot be scanned fails the gate, it does not pass silently`);
      } finally {
        cdp?.close();
      }
    }
  }

  const merged = dedupeFindings(all);
  const { primary, advisory } = classifyFindings(merged);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(merged, null, 2)}\n`);
  if (options.target === "win-gamepc" && state !== null) {
    const winDir = join(state.runDir, "win");
    mkdirSync(winDir, { recursive: true });
    writeFileSync(join(winDir, "impeccable-report.json"), `${JSON.stringify(merged, null, 2)}\n`);
  }
  return {
    runId,
    targets,
    findings: merged,
    primary,
    advisory,
    reportPath,
    skipped: false,
  };
}

/** 硬门禁：primary > 0 → 逐条打印并 exit 1；只有 advisory → exit 0。 */
function enforceGate(result: DetectResult, target: "mac" | "win-gamepc", livePort: number | null): void {
  console.log(`impeccable detect: ${result.runId} (${target})`);
  console.log(`  targets: ${result.targets.join(", ")}${livePort === null ? "" : `, --cdp ${livePort}`}`);
  console.log(`  findings: ${result.findings.length} (primary ${result.primary.length}, advisory ${result.advisory.length})`);
  console.log(`  report: ${result.reportPath}`);
  if (result.primary.length > 0) {
    for (const finding of result.primary) {
      const where = finding.file ?? finding.selector ?? "?";
      const at = finding.line !== undefined ? `:${finding.line}` : "";
      const what = finding.snippet ?? finding.message ?? finding.description ?? "";
      console.log(`fail: ${finding.antipattern ?? finding.name ?? "unknown"} @ ${where}${at} — ${what}`);
    }
    process.exit(1);
  }
}

async function detect(args: string[]): Promise<void> {
  // 没有 run 也能跑源码扫描（CI 与改动前的自查）：此时只跳过 CDP 实时扫描，
  // 有 run 却扫不到 CDP 才算门禁失效（见 runDetect）。显式写错的 --run 是拼写
  // 错误而不是「没有 run」：静默降级成源码扫描会让门禁假装通过。
  const runFlag = takeFlag(args, "--run");
  const state = tryReadState(runFlag);
  if (runFlag !== undefined && state === null) fail(`no verification run named ${runFlag}: tmp/verify/${runFlag}/state.json is missing`);
  const target = resolveTarget(takeFlag(args, "--target"), state ?? undefined);
  const sourceOnly = hasFlag(args, "--source-only");
  const result = await runDetect(state, { target, sourceOnly });
  if (result.skipped) return;
  enforceGate(result, target, sourceOnly || state === null ? null : state.port);
  appendVerifyEvent(
    state?.runDir,
    "detect",
    "impeccable-detect",
    true,
    `${result.findings.length} findings (primary ${result.primary.length}, advisory ${result.advisory.length}) in ${result.targets.join(", ")}`,
    "impeccable-report.json",
  );
}

async function prototype(args: string[]): Promise<void> {
  const round = parseRound(takeFlag(args, "--round"));
  const seedText = listed(takeFlag(args, "--seed"));
  const confirmed = listed(takeFlag(args, "--confirmed"));
  const rejected = listed(takeFlag(args, "--rejected"));
  const open = listed(takeFlag(args, "--open"));
  const freeze = hasFlag(args, "--freeze");
  const runFlag = takeFlag(args, "--run");
  const stateOrNull = tryReadState(runFlag);
  if (runFlag !== undefined && stateOrNull === null) fail(`no verification run named ${runFlag}: tmp/verify/${runFlag}/state.json is missing`);
  const target = resolveTarget(takeFlag(args, "--target"), stateOrNull ?? undefined);
  const runDir = stateOrNull?.runDir;
  const record = (action: string, ok: boolean, detail: string, evidence?: string): void =>
    appendVerifyEvent(runDir, "prototype", action, ok, detail, evidence);

  const slug = slugOf(REPO);
  const productFile = join(REPO, "PRODUCT.md");

  if (freeze) {
    const cardRel = `.impeccable/rounds/round-${round}-decision-card.md`;
    const missing = [
      !existsSync(productFile) ? "PRODUCT.md" : null,
      !existsSync(join(REPO, "DESIGN.md")) ? "DESIGN.md" : null,
      !existsSync(join(REPO, cardRel)) ? cardRel : null,
    ].filter((entry): entry is string => entry !== null);
    if (missing.length > 0) {
      record("freeze", false, `missing ${missing.join(", ")}`);
      fail(`freeze blocked: missing ${missing.join(", ")}`);
    }
    const openCount = countOpenQuestions(readFileSync(join(REPO, cardRel), "utf8"));
    if (openCount > 0) {
      record("freeze", false, `${openCount} open question(s) in ${cardRel}`);
      fail(`freeze blocked: ${openCount} open question(s) remain in ${cardRel} (only "- None" / "无" is allowed)`);
    }
    if (stateOrNull === null) {
      record("freeze", false, "no verification run: the live Electron CDP session is required for the baseline");
      fail("freeze blocked: no verification run (run `verify.ts up` first) — the baseline is captured through the live Electron CDP session");
    }
    const detect = await runDetect(stateOrNull, { target, sourceOnly: false });
    if (detect.skipped) fail("freeze blocked: impeccable detect was skipped (no binary on this machine)");
    if (detect.primary.length > 0) {
      record("freeze-detect", false, `${detect.primary.length} primary impeccable findings`);
      fail(`freeze blocked: impeccable detect reports ${detect.primary.length} primary finding(s); see ${detect.reportPath}`);
    }

    const baselineDir = join(REPO, ".impeccable", "baseline");
    mkdirSync(baselineDir, { recursive: true });
    const baselineFile = join(baselineDir, "baseline.png");
    const selectorsFile = join(baselineDir, "selectors.json");
    const impeccableReportFile = join(baselineDir, "impeccable-report.json");

    let cdp: Cdp;
    try {
      cdp = await Cdp.open(stateOrNull.port);
    } catch (err) {
      record("freeze-baseline", false, `no live Electron on port ${stateOrNull.port}: ${String(err)}`);
      fail(`freeze blocked: no live Electron CDP session (start one with \`verify.ts up\`): ${String(err)}`);
    }
    try {
      const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      writeFileSync(baselineFile, Buffer.from(shot.data, "base64"));
      const dom = await cdp.eval<{ url: string; title: string; testids: string[] }>(
        `(() => {
          const testids = Array.from(document.querySelectorAll("[data-testid]"))
            .map((el) => el.getAttribute("data-testid"))
            .filter((value) => typeof value === "string" && value.length > 0);
          return { url: location.href, title: document.title, testids: Array.from(new Set(testids)).sort() };
        })()`,
      );
      const required = {
        app_version: dom.testids.includes("app-version"),
        nav_library: dom.testids.includes("nav-library"),
        breadcrumb: dom.testids.includes("breadcrumb"),
      };
      const absent = (Object.entries(required) as Array<[string, boolean]>)
        .filter(([, value]) => !value)
        .map(([key]) => key);
      if (absent.length > 0) {
        record("freeze-baseline", false, `missing required selector(s): ${absent.join(", ")}`);
        fail(`freeze blocked: the running app lacks required [data-testid] selector(s): ${absent.join(", ")}`);
      }
      writeFileSync(
        selectorsFile,
        `${JSON.stringify(
          {
            url: dom.url,
            title: dom.title,
            captured_at: new Date().toISOString(),
            run_id: stateOrNull.runId,
            round,
            required,
            testids: dom.testids,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      cdp.close();
    }
    writeFileSync(impeccableReportFile, `${JSON.stringify(detect.findings, null, 2)}\n`);

    const manifest = {
      run_id: stateOrNull.runId,
      round,
      frozen_at: new Date().toISOString(),
      baseline_commit: revParse(),
      open_questions: 0,
      detect: {
        targets: detect.targets,
        findings: detect.findings.length,
        primary: 0,
        advisory: detect.advisory.length,
        report: ".impeccable/baseline/impeccable-report.json",
      },
      baseline: {
        baseline: { file: ".impeccable/baseline/baseline.png", sha256: createHash("sha256").update(readFileSync(baselineFile)).digest("hex") },
        selectors: { file: ".impeccable/baseline/selectors.json", sha256: createHash("sha256").update(readFileSync(selectorsFile)).digest("hex") },
        impeccable_report: { file: ".impeccable/baseline/impeccable-report.json", sha256: createHash("sha256").update(readFileSync(impeccableReportFile)).digest("hex") },
      },
    };
    const manifestFile = join(baselineDir, "freeze-manifest.json");
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    record("freeze", true, `.impeccable/baseline/ (round ${round}, 0 open questions)`, ".impeccable/baseline/freeze-manifest.json");
    console.log(
      JSON.stringify(
        {
          run_id: stateOrNull.runId,
          status: "frozen",
          round,
          baseline: ".impeccable/baseline",
          files: [
            ".impeccable/baseline/baseline.png",
            ".impeccable/baseline/selectors.json",
            ".impeccable/baseline/impeccable-report.json",
            ".impeccable/baseline/freeze-manifest.json",
          ],
          manifest: ".impeccable/baseline/freeze-manifest.json",
          detect: { findings: detect.findings.length, primary: 0, advisory: detect.advisory.length },
        },
        null,
        2,
      ),
    );
    return;
  }

  // ---- Round 模式 ----
  const created = !existsSync(productFile);
  if (created) {
    writeFileSync(productFile, productTemplate(slug, seedText[0] ?? null));
  } else if (seedText.length > 0) {
    writeFileSync(productFile, appendSeeds(readFileSync(productFile, "utf8"), seedText));
  }

  const seedRun: { exitStatus: number; stdout: string; stderr: string } | null = (() => {
    const binary = resolveImpeccableBin();
    if (binary === null) {
      if (process.env.CI === "true") {
        record("concept-seed", true, "skipped: impeccable is not installed on this machine (CI)");
        return null;
      }
      fail("impeccable concept-seed is mandatory on a dev/verify machine but no binary was found; install it or set IMPECCABLE_BIN");
    }
    // concept-seed 没有位置参数、没有 --json：从工作目录读 PRODUCT.md。
    return runImpeccable(binary, ["concept-seed"], REPO);
  })();
  const seedFile = join(REPO, ".impeccable", "concept-seed.txt");
  if (seedRun !== null) {
    mkdirSync(dirname(seedFile), { recursive: true });
    writeFileSync(seedFile, `${seedRun.stdout}${seedRun.stderr ? `\n${seedRun.stderr}` : ""}`);
    const seedOk = seedRun.exitStatus === 0;
    record(
      "concept-seed",
      seedOk,
      seedOk ? ".impeccable/concept-seed.txt" : `impeccable concept-seed exited ${seedRun.exitStatus}: ${seedRun.stderr.trim().split("\n").slice(-2).join(" ")}`,
      ".impeccable/concept-seed.txt",
    );
    if (!seedOk) {
      fail(`impeccable concept-seed failed (exit ${seedRun.exitStatus}); PRODUCT.md must exist in the repo root`);
    }
  }

  const cardRel = `.impeccable/rounds/round-${round}-decision-card.md`;
  const briefRel = `.impeccable/briefs/round-${round}-decisions.md`;
  const cardFile = join(REPO, cardRel);
  mkdirSync(dirname(cardFile), { recursive: true });
  mkdirSync(join(REPO, ".impeccable", "briefs"), { recursive: true });
  const previous = existsSync(cardFile) ? readFileSync(cardFile, "utf8") : cardTemplate(round, stateOrNull?.runId ?? "(no run)", slug);
  const header = [
    `# Round ${round} — Decision Card (${slug})`,
    "",
    `- run: \`${stateOrNull?.runId ?? "(no run)"}\``,
    `- round: ${round}`,
    `- updated: ${new Date().toISOString()}`,
    `- PRODUCT.md: ${created ? "created this round" : "updated this round"}`,
    "",
  ];
  // `--open None`（或 无 / clear）是本轮收口的方式：重置待决节，而不是追加占位 bullet。
  const clearOpen = open.some((entry) => /^(none|无|clear|clear all)$/i.test(entry));
  const card = renderCard(
    previous,
    header,
    { confirmed, rejected, open: clearOpen ? [] : open },
    clearOpen,
  );
  writeFileSync(cardFile, card);
  writeFileSync(join(REPO, briefRel), card);
  record(`round-${round}-decision-card`, true, `${cardRel} (+ ${briefRel})`, cardRel);

  console.log(
    JSON.stringify(
      {
        run_id: stateOrNull?.runId ?? "(no run)",
        status: "ok",
        round,
        product_md: "PRODUCT.md",
        decision_card: cardRel,
        briefs: briefRel,
        confirmed,
        rejected,
        open_questions: countOpenQuestions(card),
        next: [
          `dispatch @designer to build/iterate the round-${round} prototype`,
          `bun run design:prototype --run ${stateOrNull?.runId ?? "<run-id>"} --round ${round} --confirmed "..." --rejected "..." --open "..."`,
          `bun run design:prototype --run ${stateOrNull?.runId ?? "<run-id>"} --round ${round} --freeze`,
        ],
      },
      null,
      2,
    ),
  );
}

/**
 * secrets-gate：独立门禁，专门扫证据目录里的密钥文件。
 * `up`/`down`/`doctor` 都会跑同一条断言；这个命令让 CI 或人手动单独跑。
 */
function secretsGate(): void {
  const found = findSecretFiles(VERIFY_ROOT);
  if (found.length === 0) {
    console.log(`secrets-gate: clean (${VERIFY_ROOT})`);
    return;
  }
  process.stdout.write(`secrets-gate: ${found.length} 个密钥文件在证据目录里\n${found.map((path) => `  ${path}`).join("\n")}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
// `--target` may lead: `verify.ts --target win-gamepc up` is `verify.ts up --target win-gamepc`
if (argv[0] === "--target" && argv.length >= 3) {
  const leading = argv.splice(0, 2);
  argv.push(...leading);
}
const [command, ...rest] = argv;
// `up --help` / `down -h` 必须只打印用法：以前 `up --help` 会被当成一次没有 --run 的启动（r57 踩过）
const HELP_TOKENS = ["help", "--help", "-h"];
if (HELP_TOKENS.includes(rest[0] ?? "")) {
  console.log(HELP);
  process.exit(0);
}
switch (command) {
  case "up":
    await up(rest);
    break;
  case "doctor":
    await doctor(rest);
    break;
  case "drive":
    await drive(rest);
    break;
  case "down":
    await down(rest);
    break;
  case "runs":
    runs();
    break;
  case "tunnels":
    await tunnels(rest);
    break;
  case "secrets-gate":
    secretsGate();
    break;
  case "detect":
    await detect(rest);
    break;
  case "seed-config":
    await seedConfig(rest);
    break;
  case "export-private-config":
    await exportPrivateConfig(rest);
    break;
  case "prototype":
    await prototype(rest);
    break;
  case undefined:
  case "help":
  case "--help":
    console.log(HELP);
    break;
  default:
    fail(`unknown command: ${command}\n\n${HELP}`);
}
