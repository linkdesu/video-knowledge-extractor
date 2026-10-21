import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import {
  listLibrary,
  llmCredentialsFromEnv,
  loadDotenvFiles,
  modelDir,
  notesRoot,
  readLibraryVideo,
  resolveEndpointFromEnv,
  saveVideoCorrections,
  videoIdFor,
} from "@video-notes/core/storage";
import type { LibraryDetail as CoreLibraryDetail, LibraryVideo as CoreLibraryVideo } from "@video-notes/core/storage";
import {
  IPC,
  type CorrectionEntry,
  type ExtractTarget,
  type LibraryVideo,
  type SettingsStatus,
  type VideoDetail,
  type JobStep,
} from "../shared/ipc";
import { JobQueue, type JobHandle } from "./jobs";
import { createMediaHandler, encodeClipUrl, MEDIA_SCHEME } from "./media";

const APP_SCHEME = "vnote-app";
const RENDERER_ROOT = join(__dirname, "../renderer");

// 特权 scheme 必须在 app ready 之前注册，否则 renderer 里 <video> 无法走 standard URL 语义
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// 端点解析全在 main 完成（评审修订）：模型发现只发生一次，缓存键稳定；
// 也避开 Finder 启动时 cwd 不可靠——cwd 与 notesRoot 都在启动时求值。
const dotenvFiles = loadDotenvFiles({ cwd: process.cwd(), resolveRoot: () => notesRoot() });
const credentials = llmCredentialsFromEnv();

/** 启动时解析好的端点；未配置或未解析成功时 undefined。 */
let endpoint: { baseUrl: string; apiKey: string; model: string } | undefined;
let endpointError: string | undefined;
const endpointReady: Promise<void> = (async () => {
  if (credentials === undefined) return;
  try {
    const resolved = await resolveEndpointFromEnv();
    if (resolved !== undefined) endpoint = resolved;
  } catch (err) {
    endpointError = sanitizeError(err);
  }
})();

/** 错误与日志出口：key 一旦出现在文本里就整体替换，绝不外泄（ADR-0009 的 redact 约定）。 */
function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const key = credentials?.apiKey;
  return key !== undefined && message.includes(key) ? "内部错误（详细信息已脱敏，见日志）" : message;
}

type WorkerState = {
  proc: UtilityProcess;
  handle: JobHandle;
  cancelRequested: boolean;
  resultDelivered: boolean;
  killTimer: NodeJS.Timeout | undefined;
};

const workers = new Map<string, WorkerState>();

function killProcessTree(pid: number): void {
  // utilityProcess.kill() 不会带走 worker 里 spawn 的 ffmpeg/ffprobe，按父 pid 补杀一层
  const out = spawnSync("pgrep", ["-P", String(pid)]);
  if (out.status !== 0) return;
  for (const line of out.stdout.toString().split("\n")) {
    const childPid = Number(line);
    if (!Number.isInteger(childPid)) continue;
    try {
      process.kill(childPid, "SIGKILL");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") console.warn(sanitizeError(err));
    }
  }
}

function launchWorker(args: { jobId: string; videoId: string; sourcePath: string }): JobHandle {
  // 每个任务 fork 一个全新 worker：worker 用 once(message) 启动，复用会让第二个任务收不到 start
  const proc = utilityProcess.fork(join(__dirname, "extract-worker.js"), [], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const state: WorkerState = {
    proc,
    handle: undefined as unknown as JobHandle,
    cancelRequested: false,
    resultDelivered: false,
    killTimer: undefined,
  };
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4000);
  });
  proc.on("message", (raw: unknown) => {
    // 评审修订：cancelRequested 之后丢弃 progress/done/error，终态只由 exit 事件定
    if (state.cancelRequested) return;
    if (typeof raw !== "object" || raw === null || !("type" in raw)) return;
    if (raw.type === "progress" && "step" in raw) {
      const p = raw as { type: string; step: string; done: number; total: number; detail?: string };
      queue.progress({ step: p.step as JobStep, done: p.done, total: p.total, detail: p.detail ?? null });
    } else if (raw.type === "done" && "result" in raw) {
      state.resultDelivered = true;
      queue.finish(raw.result as Parameters<typeof queue.finish>[0]);
    } else if (raw.type === "error" && "message" in raw) {
      state.resultDelivered = true;
      queue.fail(sanitizeError((raw as { message: string }).message));
    }
  });
  let exited = false;
  proc.on("exit", (code) => {
    exited = true;
    clearTimeout(state.killTimer);
    workers.delete(args.jobId);
    if (state.cancelRequested) {
      // 取消的终态必须等 exit 后才落：此时 ffmpeg 子进程已确认收尸
      queue.cancelled(args.jobId);
      return;
    }
    if (state.resultDelivered) return; // done/error 已经定了终态
    const tail = stderr.trim().split("\n").slice(-8).join("\n");
    queue.fail(sanitizeError(new Error(`worker 进程退出（退出码 ${code ?? "未知"}）${tail ? `\n${tail}` : ""}`)));
  });
  state.handle = {
    cancel() {
      if (state.cancelRequested) return;
      state.cancelRequested = true;
      try {
        proc.postMessage({ type: "cancel" });
      } catch {
        // 进程已死：直接杀，exit 事件会定终态
      if (proc.pid !== undefined) killProcessTree(proc.pid);
        try {
          proc.kill();
        } catch {
          /* 已退出 */
        }
        return;
      }
      // worker 收到 cancel 会 killActiveChildren 后 exit(0)；1.5s 没退出就强杀进程树，
      // 但终态仍等 exit 事件
      state.killTimer = setTimeout(() => {
        if (!exited && proc.pid !== undefined) killProcessTree(proc.pid);
        try {
          proc.kill();
        } catch {
          /* 已退出 */
        }
      }, 1500);
    },
    kill() {
      clearTimeout(state.killTimer);
      if (proc.pid !== undefined) killProcessTree(proc.pid);
      try {
        proc.kill();
      } catch {
        /* 已退出 */
      }
    },
  };
  workers.set(args.jobId, state);
  proc.postMessage({
    type: "start",
    videoPath: args.sourcePath,
    notesRoot: notesRoot(),
    modelDir: modelDir(),
    // startExtract 已保证配置齐全；空值兜底让 worker 自己报脱敏错误
    endpoint: endpoint ?? { baseUrl: "", apiKey: "", model: "" },
  });
  return state.handle;
}

const queue = new JobQueue({
  launch: launchWorker,
  onChange: (snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.jobEvent, snapshot);
    }
  },
});

function toVideoDto(v: CoreLibraryVideo): LibraryVideo {
  return {
    id: v.id,
    title: v.title,
    outputDir: v.outputDir,
    sourcePath: v.sourcePath ?? null,
    topicCount: v.topicCount,
    clipCount: v.clipCount,
    updatedAt: v.updatedAt,
  };
}

function toDetailDto(d: CoreLibraryDetail): VideoDetail {
  return {
    video: toVideoDto(d.video),
    indexMarkdown: d.indexMarkdown,
    topics: d.topics.map((t) => ({
      dirName: t.dirName,
      title: t.title,
      markdown: t.markdown,
      clips: t.clips.map((c) => ({
        file: c.file,
        mediaUrl: encodeClipUrl(`${basename(d.video.outputDir)}/${t.dirName}/${c.file}`),
        startSeconds: c.start,
        endSeconds: c.end,
      })),
    })),
    corrections: d.corrections,
  };
}

async function startExtract(target: ExtractTarget): Promise<{ jobId: string }> {
  await endpointReady;
  if (credentials === undefined) {
    throw new Error("未配置 LLM 端点：请在 .env 或环境变量里设置 base url 与 api key");
  }
  if (endpoint === undefined) {
    throw new Error(`模型发现失败：请在 .env 里显式指定 model（${endpointError}）`);
  }
  let videoId: string;
  let sourcePath: string;
  if (target.kind === "new") {
    let st;
    try {
      st = statSync(target.sourcePath);
    } catch {
      throw new Error("源文件不存在");
    }
    if (!st.isFile()) throw new Error("所选路径不是文件");
    videoId = videoIdFor(target.sourcePath);
    sourcePath = target.sourcePath;
  } else {
    const entry = listLibrary().find((v) => v.id === target.videoId);
    if (entry === undefined) throw new Error("该视频不在库中");
    if (target.sourcePath !== undefined && videoIdFor(target.sourcePath) !== target.videoId) {
      throw new Error("源文件与这个视频不符");
    }
    videoId = target.videoId;
    sourcePath = target.sourcePath ?? entry.sourcePath ?? "";
    if (sourcePath === "") throw new Error("该视频没有源文件记录，请先选择源文件");
  }
  return { jobId: queue.enqueue({ videoId, sourcePath }) };
}

async function pickVideo(): Promise<string | null> {
  const res = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      { name: "视频", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "ts", "flv"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  return res.canceled ? null : (res.filePaths[0] ?? null);
}

async function pickSource(videoId: string): Promise<string | null> {
  const path = await pickVideo();
  if (path === null) return null;
  if (videoIdFor(path) !== videoId) throw new Error("选的文件不是这个视频的源文件");
  return path;
}

function reveal(outputDir: string): void {
  const root = resolve(notesRoot());
  const dir = resolve(outputDir);
  if (dir !== root && !dir.startsWith(root + sep)) throw new Error("目录不在 notes 根目录内");
  if (!existsSync(dir)) throw new Error("目录不存在");
  shell.showItemInFolder(dir);
}

async function settings(): Promise<SettingsStatus> {
  // 启动时的模型发现只做一次，设置页等它结束就能显示实际名字
  await endpointReady;
  const ff = spawnSync("ffmpeg", ["-version"]);
  return {
    configured: credentials !== undefined,
    model: credentials?.model ?? null,
    discoveredModel: credentials?.model === undefined ? (endpoint?.model ?? null) : null,
    modelError: endpointError ?? null,
    notesRoot: notesRoot(),
    modelDir: modelDir(),
    dotenvFiles,
    ffmpeg: ff.status === 0,
  };
}

// 所有 IPC handler 统一过脱敏出口：key 绝不进 renderer 的异常消息
function guard<T extends unknown[]>(fn: (...args: T) => unknown | Promise<unknown>): (...args: T) => Promise<unknown> {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw new Error(sanitizeError(err));
    }
  };
}

let quitting = false;
app.on("before-quit", (event) => {
  // 评审修订：退出前先取消运行中任务并等 worker 退出，避免留下运行中的 ffmpeg
  if (quitting || !queue.busy()) return;
  event.preventDefault();
  quitting = true;
  queue.cancelAll();
  const forceQuit = setTimeout(() => {
    for (const w of workers.values()) w.handle.kill();
    app.quit();
  }, 5000);
  void queue.drain().then(() => {
    clearTimeout(forceQuit);
    app.quit();
  });
});
app.on("window-all-closed", () => {
  app.quit();
});

void app.whenReady().then(async () => {
  // 媒体协议 root 用启动时的 notesRoot() 闭包值，不走 env：
  // Finder 启动时 env 可能还没被 .env 补全，闭包值才和 settings() 一致
  protocol.handle(MEDIA_SCHEME, createMediaHandler(notesRoot()));
  // file:// 下 Chromium 拒绝执行 ES module；生产环境走自定义 standard scheme
  protocol.handle(APP_SCHEME, (request) => {
    const pathname = new URL(request.url).pathname;
    const relative = pathname === "/" || pathname === "" ? "/index.html" : pathname;
    const target = normalize(join(RENDERER_ROOT, decodeURIComponent(relative)));
    if (target !== RENDERER_ROOT && !target.startsWith(RENDERER_ROOT + sep)) {
      return new Response("forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });

  ipcMain.handle(IPC.listLibrary, guard(() => listLibrary().map(toVideoDto)));
  ipcMain.handle(
    IPC.getVideo,
    guard((_e, videoId: string) => {
      const detail = readLibraryVideo(notesRoot(), videoId);
      if (detail === undefined) throw new Error("视频不存在");
      return toDetailDto(detail);
    }),
  );
  ipcMain.handle(
    IPC.saveCorrections,
    guard((_e, videoId: string, entries: CorrectionEntry[]) => {
      const entry = listLibrary().find((v) => v.id === videoId);
      if (entry === undefined) throw new Error("视频不存在");
      return saveVideoCorrections(entry.outputDir, entries);
    }),
  );
  ipcMain.handle(IPC.pickVideo, guard(() => pickVideo()));
  ipcMain.handle(IPC.pickSource, guard((_e, videoId: string) => pickSource(videoId)));
  ipcMain.handle(IPC.startExtract, guard((_e, target: ExtractTarget) => startExtract(target)));
  ipcMain.handle(IPC.cancelExtract, guard((_e, jobId: string) => queue.cancel(jobId)));
  ipcMain.handle(IPC.activeJob, guard(() => queue.active() ?? null));
  ipcMain.handle(IPC.settings, guard(() => settings()));
  ipcMain.handle(IPC.reveal, guard((_e, outputDir: string) => reveal(outputDir)));

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) await win.loadURL(devUrl);
  else await win.loadURL(`${APP_SCHEME}://bundle/index.html`);
});
