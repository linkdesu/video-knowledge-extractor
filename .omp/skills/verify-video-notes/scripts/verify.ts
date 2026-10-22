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
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../../..");
const DESKTOP = join(REPO, "apps/desktop");
const VERIFY_ROOT = join(REPO, "tmp/verify");
const LATEST = join(VERIFY_ROOT, "latest");

type RunState = {
  runId: string;
  runDir: string;
  port: number;
  pid: number;
  home: string;
  userData: string;
  modelDir: string;
  appLog: string;
  /** Set when the run drives a packaged .app instead of apps/desktop. */
  appPath?: string;
  startedAt: string;
  electron: string;
};

type Target = { type: string; url: string; title: string; webSocketDebuggerUrl: string };

const HELP = `usage: verify.ts <command>

  up [--port N] [--run ID] [--home DIR] [--user-data DIR] [--model-dir DIR] [--no-build]
     [--app PATH] [--min-path]
      Build apps/desktop, start Electron with isolated VNOTE_HOME / VNOTE_USER_DATA,
      wait until the renderer answers, write tmp/verify/<run>/state.json.
      --app drives an already packaged .app (or its executable) instead of apps/desktop,
      and implies --no-build. --min-path replaces the child PATH with launchd's
      /usr/bin:/bin:/usr/sbin:/sbin so the packaged app's PATH repair is what finds ffmpeg.

  doctor [--run ID]
      Read-only health check of the latest run: process, CDP port owner, build freshness,
      effective notes root, models/LLM readiness. Exit 1 on failure.

  drive <action> [args] [--run ID]
      eval <expr>                 evaluate JS in the renderer, print JSON
      click <selector> [--index N]  real mouse click on the element's center
      click-text <label> [--index N]  real mouse click on a button/checkbox by text or aria-label
      type <text>                 key events into the focused element
      fill <selector> <text>      focus + select + type (works on inputs/textareas)
      press <key> [--meta]        press one key (e.g. Enter, Escape)
      drop <file>                 drag a real file onto the library dropzone
      wait <expr> [--timeout MS]  poll until the expression is truthy
      text                        print document.body.innerText
      shot [name]                 PNG screenshot -> <run>/<name>.png
      snapshot [name]             accessibility tree text -> <run>/<name>.aria.txt
      status                      library + active job + settings summary
      log [lines]                 tail the Electron log

  down [--run ID]
      Stop the Electron process this helper started (never kills by name).
      Evidence under tmp/verify/<run>/ is kept.

  runs
      List runs and whether each process is still alive.
`;

function fail(message: string): never {
  process.stderr.write(`verify: ${message}\n`);
  process.exit(1);
}

function takeFlag(args: string[], name: string): string | undefined {
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

function readState(runId?: string): RunState {
  let dir: string;
  if (runId !== undefined) {
    dir = join(VERIFY_ROOT, runId);
  } else {
    if (!existsSync(LATEST)) fail("no verification run yet: run `verify.ts up` first");
    dir = join(VERIFY_ROOT, readFileSync(LATEST, "utf8").trim());
  }
  const file = join(dir, "state.json");
  if (!existsSync(file)) fail(`no state.json in ${dir}`);
  return JSON.parse(readFileSync(file, "utf8")) as RunState;
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

async function listTargets(port: number): Promise<Target[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(`CDP /json returned ${res.status}`);
  return (await res.json()) as Target[];
}

class Cdp {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const entry = this.pending.get(msg.id);
      if (entry === undefined) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    });
  }

  static async open(port: number): Promise<Cdp> {
    const targets = await listTargets(port);
    const page =
      targets.find((t) => t.type === "page" && t.url.startsWith("vnote-app://")) ??
      targets.find((t) => t.type === "page");
    if (page === undefined) throw new Error("no page target on CDP port");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const opened = Promise.withResolvers<void>();
    ws.addEventListener("open", () => opened.resolve(), { once: true });
    ws.addEventListener("error", () => opened.reject(new Error("CDP websocket failed")), { once: true });
    await opened.promise;
    return new Cdp(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    const d = Promise.withResolvers<T>();
    this.pending.set(id, { resolve: (v) => d.resolve(v as T), reject: d.reject });
    this.ws.send(JSON.stringify({ id, method, params }));
    return d.promise;
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const res = await this.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
    );
    if (res.exceptionDetails !== undefined) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "evaluate failed");
    }
    return res.result.value as T;
  }

  close(): void {
    this.ws.close();
  }
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

async function drop(cdp: Cdp, file: string): Promise<void> {
  const path = resolve(file);
  if (!existsSync(path)) fail(`file not found: ${path}`);
  const { x, y } = await elementCenter(cdp, "[data-testid=dropzone]", 0);
  const data = { items: [], files: [path], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await cdp.send("Input.dispatchDragEvent", { type, x, y, data });
  }
}

async function snapshot(cdp: Cdp, file: string): Promise<number> {
  await cdp.send("Accessibility.enable");
  const { nodes } = await cdp.send<{ nodes: Array<{ nodeId: string; parentId?: string; ignored?: boolean; role?: { value?: string }; name?: { value?: string }; value?: { value?: string } }> }>(
    "Accessibility.getFullAXTree",
  );
  const byParent = new Map<string, typeof nodes>();
  for (const node of nodes) {
    const key = node.parentId ?? "root";
    const list = byParent.get(key) ?? [];
    list.push(node);
    byParent.set(key, list);
  }
  const lines: string[] = [];
  const walk = (parentId: string, depth: number) => {
    for (const node of byParent.get(parentId) ?? []) {
      if (node.ignored !== true) {
        const role = node.role?.value ?? "?";
        const name = node.name?.value ?? "";
        const value = node.value?.value;
        const text = name === "" ? role : `${role} ${JSON.stringify(name)}`;
        lines.push(`${"  ".repeat(depth)}${text}${value === undefined || value === "" ? "" : ` value=${JSON.stringify(value)}`}`);
        walk(node.nodeId, depth + 1);
      } else {
        walk(node.nodeId, depth);
      }
    }
  };
  const root = nodes.find((n) => n.parentId === undefined);
  if (root !== undefined) walk(root.nodeId, 0);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return lines.length;
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

async function up(args: string[]): Promise<void> {
  const port = Number(takeFlag(args, "--port") ?? "9411");
  const runId = takeFlag(args, "--run") ?? stamp();
  const appArg = takeFlag(args, "--app");
  // --app drives an already packaged bundle: building apps/desktop cannot change what it runs
  const skipBuild = hasFlag(args, "--no-build") || appArg !== undefined;
  const minPath = hasFlag(args, "--min-path");
  const runDir = join(VERIFY_ROOT, runId);
  if (existsSync(runDir)) fail(`run already exists: ${runDir}`);
  mkdirSync(runDir, { recursive: true });

  const home = resolve(takeFlag(args, "--home") ?? join(runDir, "home"));
  const userData = resolve(takeFlag(args, "--user-data") ?? join(runDir, "user-data"));
  const modelDir = resolve(takeFlag(args, "--model-dir") ?? process.env.VNOTE_MODEL_DIR ?? join(process.env.HOME ?? ".", ".cache/video-notes/models"));
  mkdirSync(home, { recursive: true });
  mkdirSync(userData, { recursive: true });

  const buildLog = join(runDir, "build.log");
  if (!skipBuild) {
    process.stderr.write("verify: building apps/desktop …\n");
    const fd = openSync(buildLog, "w");
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: DESKTOP, stdout: fd, stderr: fd });
    if (build.exitCode !== 0) fail(`build failed (exit ${build.exitCode}); see ${buildLog}`);
  }

  try {
    await listTargets(port);
    fail(`port ${port} already has a CDP endpoint; choose another --port`);
  } catch {
    // expected: port is free
  }

  let electron: string;
  let appArgs: string[];
  let appPath: string | undefined;
  if (appArg !== undefined) {
    appPath = resolve(appArg);
    electron = bundleExecutable(appPath);
    appArgs = [`--remote-debugging-port=${port}`];
  } else {
    const devElectron = [
      join(DESKTOP, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
      join(REPO, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    ].find((path) => existsSync(path));
    if (devElectron === undefined) fail("Electron binary not found; run `bun install` in the repo root");
    electron = devElectron;
    appArgs = ["apps/desktop", `--remote-debugging-port=${port}`];
  }

  const appLog = join(runDir, "app.log");
  const logFd = openSync(appLog, "w");
  const child = Bun.spawn([electron, ...appArgs], {
    cwd: REPO,
    env: {
      ...process.env,
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
    startedAt: new Date().toISOString(),
    electron,
  };

  try {
    const started = Date.now();
    let cdp: Cdp | undefined;
    while (Date.now() - started < 40000) {
      try {
        cdp = await Cdp.open(port);
        break;
      } catch {
        await sleep(250);
      }
    }
    if (cdp === undefined) throw new Error("CDP endpoint never appeared");
    await waitFor(cdp, `typeof window.vnote === "object" && document.querySelector('[data-testid=nav-library]') !== null`, 20000);
    cdp.close();
  } catch (err) {
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
    const tail = existsSync(appLog) ? readFileSync(appLog, "utf8").split("\n").slice(-20).join("\n") : "";
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    fail(`app did not become ready: ${String(err)}\n--- app.log ---\n${tail}`);
  }

  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
  writeFileSync(LATEST, `${runId}\n`);
  console.log(`run:      ${runDir}`);
  console.log(`port:     ${port}`);
  console.log(`pid:      ${child.pid}`);
  console.log(`home:     ${home}`);
  console.log(`userData: ${userData}`);
  console.log(`log:      ${appLog}`);
  if (appPath !== undefined) console.log(`app:      ${appPath}`);
}

async function doctor(args: string[]): Promise<void> {
  const state = readState(takeFlag(args, "--run"));
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

  alive(state.pid) ? ok(`process ${state.pid} is alive (${processName(state.pid) || "unknown"})`) : bad(`process ${state.pid} is not running`);

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
      probe.notesRoot === state.home
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
    } catch (err) {
      bad(`renderer probe failed: ${String(err)}`);
    } finally {
      cdp.close();
    }
  }

  try {
    const listen = Bun.spawnSync(["lsof", "-nP", `-iTCP:${state.port}`, "-sTCP:LISTEN", "-t"]);
    const pids = listen.stdout.toString().trim().split(/\s+/).filter((v) => v !== "");
    if (listen.exitCode !== 0 || pids.length === 0) warn(`lsof reports no listener on ${state.port}`);
    else if (pids.includes(String(state.pid))) ok(`port ${state.port} is owned by pid ${state.pid}`);
    else bad(`port ${state.port} is owned by ${pids.join(",")}, not ${state.pid}`);
  } catch {
    warn("lsof unavailable; cannot prove port ownership");
  }

  if (state.appPath !== undefined) {
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

  if (problems.length > 0) {
    console.log(`\ndoctor: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`\ndoctor: healthy${notes.length > 0 ? ` (${notes.length} warning(s))` : ""}`);
}

async function drive(args: string[]): Promise<void> {
  const action = args.shift();
  if (action === undefined) fail("drive needs an action (eval|click|type|fill|press|drop|wait|text|shot|snapshot|status|log)");
  const state = readState(takeFlag(args, "--run"));
  if (!alive(state.pid)) fail(`run ${state.runId} is not running; start a new run with \`up\``);
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
        const file = args[0];
        if (file === undefined) fail("drop needs a file path");
        await drop(cdp, file);
        console.log(`dropped ${resolve(file)} on the dropzone`);
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
      case "shot": {
        const name = args[0] ?? `shot-${stamp()}`;
        const file = join(state.runDir, `${name}.png`);
        const res = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
        writeFileSync(file, Buffer.from(res.data, "base64"));
        console.log(`screenshot: ${file}`);
        break;
      }
      case "snapshot": {
        const name = args[0] ?? `snapshot-${stamp()}`;
        const file = join(state.runDir, `${name}.aria.txt`);
        const lines = await snapshot(cdp, file);
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
  const state = readState(takeFlag(args, "--run"));
  if (!alive(state.pid)) {
    console.log(`pid ${state.pid} is already gone; evidence kept at ${state.runDir}`);
    return;
  }
  const name = processName(state.pid);
  // a packaged run's process is the bundle executable ("Video Notes"), not "Electron"
  const expected = state.appPath === undefined ? "Electron" : basename(bundleExecutable(state.appPath));
  if (!name.toLowerCase().includes(expected.toLowerCase())) {
    fail(`refusing to kill pid ${state.pid}: process name is "${name}", not ${expected}`);
  }
  process.kill(state.pid, "SIGTERM");
  const started = Date.now();
  while (Date.now() - started < 8000 && alive(state.pid)) await sleep(100);
  if (alive(state.pid)) {
    process.kill(state.pid, "SIGKILL");
    await sleep(300);
  }
  if (alive(state.pid)) fail(`pid ${state.pid} did not exit`);
  console.log(`stopped pid ${state.pid}; evidence kept at ${state.runDir}`);
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
    console.log(`${entry.name}  port=${state.port}  pid=${state.pid}  ${alive(state.pid) ? "running" : "stopped"}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
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
  case undefined:
  case "help":
  case "--help":
    console.log(HELP);
    break;
  default:
    fail(`unknown command: ${command}\n\n${HELP}`);
}
