import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, normalize, resolve, sep } from "node:path";
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
  ASR_MODEL_ID,
  cacheUsage,
  clearCache,
  loadDotenvFiles,
  llmCredentialsFromEnv,
  loadSettings,
  listLibrary,
  readLibraryVideo,
  readGlobalCorrections,
  readVideoCorrections,
  renameSpeaker,
  deleteUtterance,
  deleteTopicSegment,
  mergeTopics,
  resolveEndpointFromEnv,
  saveGlobalCorrections,
  saveSettings,
  saveVideoCorrections,
  setTopicSelected,
  settingsLockedByEnv,
  SETTINGS_FILE_NAME,
  videoIdFor,
} from "@video-notes/core/storage";
import type { AppSettings, CorrectionFileEntry, LibraryVideo as CoreLibraryVideo, LibraryDetail as CoreLibraryDetail, VideoRef } from "@video-notes/core/storage";
import {
  IPC,
  type CorrectionEntry,
  type ExtractTarget,
  type JobStep,
  type SettingsPatch,
  type SettingsStatus,
  type TestLlmResult,
  type VideoDetail,
} from "../shared/ipc";
import { JobQueue, type JobHandle, type JobRequest } from "./jobs";
import { createMediaHandler, encodeClipUrl, encodeSourceUrl, MEDIA_SCHEME } from "./media";

const APP_SCHEME = "vnote-app";
const RENDERER_ROOT = join(__dirname, "../renderer");

// 特权 scheme 必须在 app ready 之前注册，否则 renderer 里 <video> 无法走 standard URL 语义
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// 启动时读一次 settings.json；handler 都读这个可变对象，
// settings:update 原地更新它，任务入队时按当时的值冻结
const settings: AppSettings = loadSettings(join(app.getPath("userData"), SETTINGS_FILE_NAME));
// .env 的查找根目录来自 settings（notes 根），所以必须先读 settings 再加载 dotenv
loadDotenvFiles({ cwd: process.cwd(), resolveRoot: () => settings.notesRoot });
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

function launchWorker(jobId: string, job: JobRequest): JobHandle {
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
      const p = raw as { type: string; step: string; done: number; total: number; detail?: string; topicId?: string; topicPercent?: number };
      queue.progress({
        step: p.step as JobStep,
        done: p.done,
        total: p.total,
        detail: p.detail ?? null,
        topicId: typeof p.topicId === "string" ? p.topicId : null,
        topicPercent: typeof p.topicPercent === "number" ? p.topicPercent : null,
      });
    } else if (raw.type === "done" && "result" in raw) {
      state.resultDelivered = true;
      queue.finish(raw.result as Parameters<typeof queue.finish>[0]);
    } else if (raw.type === "error" && "message" in raw) {
      state.resultDelivered = true;
      queue.fail(sanitizeError(new Error((raw as { message: string }).message)));
    }
  });
  let exited = false;
  proc.on("exit", (code) => {
    exited = true;
    clearTimeout(state.killTimer);
    workers.delete(jobId);
    if (state.cancelRequested) {
      // 取消的终态必须等 exit 后才落：此时 ffmpeg 子进程已确认收尸
      queue.cancelled(jobId);
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
      let posted = false;
      try {
        proc.postMessage({ type: "cancel" });
        posted = true;
      } catch {
        // 进程已死：直接杀，exit 事件会定终态
      }
      if (!posted) {
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
  workers.set(jobId, state);
  proc.postMessage({
    type: "start",
    kind: job.kind,
    videoId: job.videoId,
    videoPath: job.sourcePath,
    outputDir: job.outputDir ?? "",
    notesRoot: job.config.notesRoot,
    cacheRoot: job.config.cacheRoot,
    modelDir: job.config.modelDir,
    topicIds: job.topicIds ?? [],
    // 启动 handler 已保证配置齐全；空值兜底让 worker 自己报脱敏错误
    endpoint: endpoint ?? { baseUrl: "", apiKey: "", model: "" },
  });
  return state.handle;
}

const queue = new JobQueue({
  launch: (jobId, job) => launchWorker(jobId, job),
  onChange: (snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.jobEvent, snapshot);
    }
  },
});

function toVideoDto(v: CoreLibraryVideo) {
  return {
    id: v.id,
    title: v.title,
    outputDir: v.outputDir,
    sourcePath: v.sourcePath ?? null,
    durationSeconds: v.durationSeconds ?? null,
    importedAt: "importedAt" in v ? (v.importedAt ?? null) : null,
    sizeBytes: "sizeBytes" in v ? (v.sizeBytes ?? null) : null,
    topicCount: v.topicCount,
    clipCount: v.clipCount,
    updatedAt: v.updatedAt,
    status: v.status,
  };
}

const SPEAKER_COLORS = ["#6aa9ff", "#7ddc8f", "#ffb454", "#c792ea", "#ff7eb0", "#4dd0e1", "#f6c744", "#a3e635"];

function speakerColor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SPEAKER_COLORS[hash % SPEAKER_COLORS.length] ?? "#6aa9ff";
}

function fileMtimeIso(path: string): string | null {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

function toCorrectionFile(e: CorrectionEntry): CorrectionFileEntry {
  const entry: CorrectionFileEntry = { wrong: e.wrong, right: e.right };
  if (e.source !== null) entry.source = e.source;
  if (e.updatedAt !== null) entry.updatedAt = e.updatedAt;
  return entry;
}

function toDetailDto(d: CoreLibraryDetail): VideoDetail {
  const raw = d.data;
  const video = d.video;
  const mtimeIso = fileMtimeIso(join(video.outputDir, "corrections.json"));
  return {
    video: toVideoDto(video),
    mediaUrl: video.sourcePath === undefined || video.sourcePath === "" ? null : encodeSourceUrl(video.id),
    asrModel: "asrModel" in raw ? (raw.asrModel ?? null) : null,
    transcript:
      raw.transcript.utterances.length === 0
        ? null
        : {
            speakers: raw.transcript.speakers.map((s) => ({ id: s.id, name: s.name, color: speakerColor(s.id) })),
            utterances: raw.transcript.utterances.map((u, i) => ({
              index: i,
              start: u.start,
              end: u.end,
              speakerId: u.speakerId,
              text: u.text,
            })),
          },
    topics: raw.topics.map((t) => ({
      id: t.id,
      title: t.title,
      summary: t.summary,
      segments: t.segments.map((s) => ({ start: s.start, end: s.end })),
      dirName: t.dirName,
      status: t.status,
      selected: t.selected,
      keyPoints: t.keyPoints,
      clips: t.clips.map((c) => ({
        file: c.file,
        mediaUrl: encodeClipUrl(`${basename(video.outputDir)}/${t.dirName}/${c.file}`),
        startSeconds: c.start,
        endSeconds: c.end,
        segmentIndexes: "segmentIndexes" in c ? c.segmentIndexes : [],
      })),
      startedAt: t.startedAt,
      elapsedSeconds: t.elapsedSeconds,
      error: t.error,
    })),
    corrections: d.corrections.map((e) => ({
      wrong: e.wrong,
      right: e.right,
      source: e.source ?? null,
      updatedAt: e.updatedAt ?? mtimeIso,
    })),
  };
}

/** 全局术语表：缺 updatedAt 显示「—」，不回落文件 mtime（评审修订）。 */
function toGlossaryDto(entries: CorrectionFileEntry[]): CorrectionEntry[] {
  return entries.map((e) => ({
    wrong: e.wrong,
    right: e.right,
    source: e.source ?? null,
    updatedAt: e.updatedAt ?? null,
  }));
}

/** 编辑 handler 的公共前置：按 id 解析视频，失败用中文报错。 */
function resolveVideo(videoId: string): CoreLibraryVideo {
  const entry = listLibrary(settings.notesRoot).find((v) => v.id === videoId);
  if (entry === undefined) throw new Error("该视频不在库中");
  return entry;
}

function videoRefOf(entry: CoreLibraryVideo): VideoRef {
  return { id: entry.id, title: entry.title, sourcePath: entry.sourcePath };
}

function detailDto(videoId: string): VideoDetail {
  const detail = readLibraryVideo(settings.notesRoot, videoId);
  if (detail === undefined) throw new Error("视频不存在");
  return toDetailDto(detail);
}

async function ensurePipelineReady(): Promise<void> {
  await endpointReady;
  if (credentials === undefined) {
    throw new Error("未配置 LLM 端点：请在 .env 或环境变量里设置 base url 与 api key");
  }
  if (endpoint === undefined) {
    throw new Error(`模型发现失败：请在 .env 里显式指定 model（${endpointError}）`);
  }
  if (queue.busy()) throw new Error("已有任务在运行，请等它结束再开始");
}

async function startExtract(target: ExtractTarget): Promise<{ jobId: string }> {
  await ensurePipelineReady();
  let videoId: string;
  let sourcePath: string;
  let outputDir: string | null;
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
    outputDir = null;
  } else {
    const entry = resolveVideo(target.videoId);
    if (target.sourcePath !== undefined && videoIdFor(target.sourcePath) !== target.videoId) {
      throw new Error("源文件与这个视频不符");
    }
    videoId = target.videoId;
    sourcePath = target.sourcePath ?? entry.sourcePath ?? "";
    if (sourcePath === "") throw new Error("该视频没有源文件记录，请先选择源文件");
    outputDir = entry.outputDir;
  }
  return { jobId: queue.enqueue({ kind: "extract", videoId, sourcePath, outputDir, config: { ...settings } }) };
}

async function startNotes(videoId: string, topicIds: string[]): Promise<{ jobId: string }> {
  await ensurePipelineReady();
  const entry = resolveVideo(videoId);
  if (topicIds.length === 0) throw new Error("请先勾选要生成的主题");
  return { jobId: queue.enqueue({ kind: "notes", videoId, sourcePath: entry.sourcePath ?? "", outputDir: entry.outputDir, config: { ...settings }, topicIds }) };
}

async function rebuildTopics(videoId: string): Promise<{ jobId: string }> {
  await ensurePipelineReady();
  const entry = resolveVideo(videoId);
  return { jobId: queue.enqueue({ kind: "topics", videoId, sourcePath: entry.sourcePath ?? "", outputDir: entry.outputDir, config: { ...settings } }) };
}

async function pickVideo(): Promise<string | null> {
  const res = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "视频", extensions: ["mp4", "mov", "m4v", "webm"] }],
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
  const root = resolve(settings.notesRoot);
  const dir = resolve(outputDir);
  if (dir !== root && !dir.startsWith(root + sep)) throw new Error("目录不在 notes 根目录内");
  if (!existsSync(dir)) throw new Error("目录不存在");
  shell.showItemInFolder(dir);
}

function ffmpegProbe(): { ok: boolean; version: string | null } {
  const ff = spawnSync("ffmpeg", ["-version"]);
  if (ff.status !== 0) return { ok: false, version: null };
  const first = ff.stdout.toString().split("\n")[0] ?? "";
  const m = first.match(/^ffmpeg version (\S+)/);
  return { ok: true, version: m?.[1] ?? null };
}

function llmStatus(): SettingsStatus["llm"] {
  return {
    configured: credentials !== undefined,
    baseUrl: credentials?.baseUrl ?? null,
    model: credentials?.model ?? null,
    discoveredModel: credentials?.model === undefined ? (endpoint?.model ?? null) : null,
    error: endpointError ?? null,
  };
}

async function settingsStatus(): Promise<SettingsStatus> {
  // 启动时的模型发现只做一次，设置页等它结束就能显示实际名字
  await endpointReady;
  const ff = ffmpegProbe();
  return {
    notesRoot: settings.notesRoot,
    cacheRoot: settings.cacheRoot,
    modelDir: settings.modelDir,
    cacheBytes: cacheUsage(settings.cacheRoot).bytes,
    llm: llmStatus(),
    asr: { provider: "sherpa-onnx", modelId: ASR_MODEL_ID, modelPresent: existsSync(join(settings.modelDir, ASR_MODEL_ID)) },
    ffmpeg: ff.ok,
    ffmpegVersion: ff.version,
    locked: settingsLockedByEnv(),
    appVersion: app.getVersion(),
  };
}

async function updateSettings(patch: SettingsPatch): Promise<SettingsStatus> {
  if (queue.busy()) throw new Error("已有任务在运行，请等它结束再修改设置");
  const clean: Partial<AppSettings> = {};
  if (patch.notesRoot !== undefined) {
    if (!isAbsolute(patch.notesRoot) || patch.notesRoot === "") throw new Error("设置 notesRoot 必须是非空绝对路径");
    clean.notesRoot = patch.notesRoot;
  }
  if (patch.cacheRoot !== undefined) {
    if (!isAbsolute(patch.cacheRoot) || patch.cacheRoot === "") throw new Error("设置 cacheRoot 必须是非空绝对路径");
    clean.cacheRoot = patch.cacheRoot;
  }
  if (patch.modelDir !== undefined) {
    if (!isAbsolute(patch.modelDir) || patch.modelDir === "") throw new Error("设置 modelDir 必须是非空绝对路径");
    clean.modelDir = patch.modelDir;
  }
  Object.assign(settings, saveSettings(join(app.getPath("userData"), SETTINGS_FILE_NAME), clean));
  return settingsStatus();
}

async function pickDirectory(): Promise<string | null> {
  const res = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  return res.canceled ? null : (res.filePaths[0] ?? null);
}

function clearCacheNow(): { freedBytes: number } {
  return { freedBytes: clearCache(settings.cacheRoot, listLibrary(settings.notesRoot).map((v) => v.outputDir)) };
}

async function testLlm(): Promise<TestLlmResult> {
  if (credentials === undefined) return { ok: false, model: null, message: "未配置 LLM 端点：请在 .env 或环境变量里设置 base url 与 api key" };
  const url = `${credentials.baseUrl.replace(/\/$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${credentials.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, model: null, message: `连接失败：HTTP ${res.status}` };
    const body = (await res.json().catch(() => undefined)) as { data?: { id: string }[] } | undefined;
    const model = body?.data?.[0]?.id ?? null;
    return { ok: true, model, message: model === null ? "连接成功，但返回的模型列表为空" : `连接成功，已发现模型 ${model}` };
  } catch (err) {
    return { ok: false, model: null, message: sanitizeError(err) };
  } finally {
    clearTimeout(timer);
  }
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
  // 媒体协议 root 读 settings 当前值（env 启动时可能没被 .env 补全，settings 才和界面一致）；
  // 源视频路径用当前 notes 根目录的库记录来校验
  protocol.handle(
    MEDIA_SCHEME,
    createMediaHandler({
      root: () => settings.notesRoot,
      resolveSource: (videoId) => listLibrary(settings.notesRoot).find((v) => v.id === videoId)?.sourcePath,
    }),
  );
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

  ipcMain.handle(IPC.listLibrary, guard(() => listLibrary(settings.notesRoot).map(toVideoDto)));
  ipcMain.handle(
    IPC.getVideo,
    guard((_e, videoId: string) => {
      const detail = readLibraryVideo(settings.notesRoot, videoId);
      if (detail === undefined) throw new Error("视频不存在");
      return toDetailDto(detail);
    }),
  );
  ipcMain.handle(
    IPC.renameSpeaker,
    guard((_e, videoId: string, speakerId: string, name: string) => {
      const entry = resolveVideo(videoId);
      renameSpeaker(entry.outputDir, speakerId, name);
      return detailDto(videoId);
    }),
  );
  ipcMain.handle(
    IPC.deleteUtterance,
    guard((_e, videoId: string, index: number) => {
      const entry = resolveVideo(videoId);
      deleteUtterance(entry.outputDir, index);
      return detailDto(videoId);
    }),
  );
  ipcMain.handle(
    IPC.deleteTopicSegment,
    guard((_e, videoId: string, topicId: string, segmentIndex: number) => {
      const entry = resolveVideo(videoId);
      deleteTopicSegment(entry.outputDir, topicId, segmentIndex);
      return detailDto(videoId);
    }),
  );
  ipcMain.handle(
    IPC.mergeTopics,
    guard((_e, videoId: string, topicIds: string[]) => {
      const entry = resolveVideo(videoId);
      mergeTopics(entry.outputDir, topicIds);
      return detailDto(videoId);
    }),
  );
  ipcMain.handle(
    IPC.setTopicSelected,
    guard((_e, videoId: string, topicId: string, selected: boolean) => {
      const entry = resolveVideo(videoId);
      setTopicSelected(entry.outputDir, topicId, selected);
      return detailDto(videoId);
    }),
  );
  ipcMain.handle(
    IPC.saveCorrections,
    guard((_e, videoId: string, entries: CorrectionEntry[]) => {
      const entry = resolveVideo(videoId);
      const saved = saveVideoCorrections(entry.outputDir, entries.map(toCorrectionFile));
      const mtimeIso = fileMtimeIso(join(entry.outputDir, "corrections.json"));
      return saved.map((e) => ({ wrong: e.wrong, right: e.right, source: e.source ?? null, updatedAt: e.updatedAt ?? mtimeIso }));
    }),
  );
  ipcMain.handle(IPC.listGlossary, guard(() => toGlossaryDto(readGlobalCorrections(settings.notesRoot))));
  ipcMain.handle(IPC.saveGlossary, guard((_e, entries: CorrectionEntry[]) => toGlossaryDto(saveGlobalCorrections(settings.notesRoot, entries.map(toCorrectionFile)))));
  ipcMain.handle(IPC.pickVideo, guard(() => pickVideo()));
  ipcMain.handle(IPC.pickSource, guard((_e, videoId: string) => pickSource(videoId)));
  ipcMain.handle(IPC.startExtract, guard((_e, target: ExtractTarget) => startExtract(target)));
  ipcMain.handle(IPC.startNotes, guard((_e, videoId: string, topicIds: string[]) => startNotes(videoId, topicIds)));
  ipcMain.handle(IPC.rebuildTopics, guard((_e, videoId: string) => rebuildTopics(videoId)));
  ipcMain.handle(IPC.cancelExtract, guard((_e, jobId: string) => queue.cancel(jobId)));
  ipcMain.handle(IPC.activeJob, guard(() => queue.active() ?? null));
  ipcMain.handle(IPC.settings, guard(() => settingsStatus()));
  ipcMain.handle(IPC.updateSettings, guard((_e, patch: SettingsPatch) => updateSettings(patch)));
  ipcMain.handle(IPC.pickDirectory, guard(() => pickDirectory()));
  ipcMain.handle(IPC.clearCache, guard(() => clearCacheNow()));
  ipcMain.handle(IPC.testLlm, guard(() => testLlm()));
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
