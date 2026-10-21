import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { basename, join, normalize, resolve, sep } from "node:path";
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  shell,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import {
  ASR_MODEL_ID,
  cacheUsage,
  clearCache,
  importModels,
  loadDotenvFiles,
  markAutoDownloadAttempted,
  modelStatus,
  recoverInterruptedRun,
  readGlobalCorrections,
  readLibraryVideo,
  readSettingsFileSafe,
  readVideoCorrections,
  renameSpeaker,
  deleteUtterance,
  deleteTopicSegment,
  mergeTopics,
  resolveAsr,
  resolveLlm,
  resolveLlmEndpoint,
  resolveSettings,
  saveGlobalCorrections,
  saveVideoCorrections,
  setTopicSelected,
  verifyModels,
  videoIdFor,
  listLibrary,
  saveSettings,
  acquireModelLock,
} from "@video-notes/core";
import type {
  AppSettings,
  CorrectionFileEntry,
  LibraryVideo as CoreLibraryVideo,
  LibraryDetail as CoreLibraryDetail,
  VideoRef,
} from "@video-notes/core";
import {
  IPC,
  type AsrUpdatePatch,
  type CorrectionEntry,
  type DirectoryKind,
  type ExtractTarget,
  type ImportModelsResult,
  type JobKind,
  type JobStep,
  type LlmUpdatePatch,
  type ModelsStatus,
  type SettingsPatch,
  type SettingsStatus,
  type TestAsrResult,
  type TestLlmResult,
  type VideoDetail,
} from "../shared/ipc";
import { JobQueue, type JobHandle, type JobRequest } from "./jobs";
import { createMediaHandler, encodeClipUrl, encodeSourceUrl, MEDIA_SCHEME } from "./media";
import { createSecretStore, type SecretCodec, type SecretStore } from "./secrets";
import { commitCredentialUpdate, replayCredentialTransaction } from "./settings-tx";
import { createModelDownloader } from "./models-downloader";

// 测试隔离（ADR-0015 §12）：验收夹具用 VNOTE_USER_DATA 隔离 userData，避免改写真实
// ~/Library/Application Support/@video-notes 的 settings.json/secrets.bin；必须在任何 getPath("userData") 之前
if (process.env.VNOTE_USER_DATA !== undefined && process.env.VNOTE_USER_DATA !== "") {
  mkdirSync(process.env.VNOTE_USER_DATA, { recursive: true });
  app.setPath("userData", resolve(process.env.VNOTE_USER_DATA));
}

const APP_SCHEME = "vnote-app";
const RENDERER_ROOT = join(__dirname, "../renderer");

// 特权 scheme 必须在 app ready 之前注册，否则 renderer 里 <video> 无法走 standard URL 语义
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// 主进程单实例（ADR-0015 §4）：写方入口只有 main，锁接管竞态压到可忽略
if (!app.requestSingleInstanceLock()) app.quit();

// 启动顺序（ADR-0015 §3）：
// 1) readSettingsFileSafe —— 文件层唯一入口，坏文件隔离成 .bad-* 后按空文件继续
const SETTINGS_PATH = () => join(app.getPath("userData"), "settings.json");
const settingsRead = readSettingsFileSafe(SETTINGS_PATH());
// 2) cwd .env → 3) 用此时 env 求 notes 根 → 根 .env
loadDotenvFiles({ cwd: process.cwd(), resolveRoot: () => process.env.VNOTE_HOME ?? settingsRead.file.notesRoot ?? `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/Documents/video-notes` });
// 4) 文件层 + 完整 env 求有效设置与 locked（不重读磁盘）
const resolved = resolveSettings(settingsRead.file, process.env);
let settings: AppSettings = resolved.settings;
const locked = resolved.locked;
let settingsFileError: string | null = settingsRead.error;

// Electron codec 包装 safeStorage（ready 后可用）；单测注入假 codec
const electronCodec: SecretCodec = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain: string) => safeStorage.encryptString(plain),
  decrypt: (cipher: Buffer) => safeStorage.decryptString(cipher),
};
let secretStore: ReturnType<typeof createSecretStore> | undefined;
let txError: string | null = null;

/** 单个 in-flight 下载器；状态查询与操作共用（ADR-0015 §4）。 */
const modelsDownloader = createModelDownloader();

/** 所有设置写操作串成一条链，避免 lost update（ADR-0015 §2）。 */
let settingsWriteChain: Promise<void> = Promise.resolve();
function withSettingsWrite<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = settingsWriteChain.then(fn) as Promise<T>;
  settingsWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

/** 运行时配置：设置变更后重算；key 只在 main/worker 内存里。 */
type LlmRuntime = {
  endpoint: { baseUrl: string; apiKey: string; model: string } | undefined;
  discoveredModel: string | null;
  keySource: "env" | "stored" | "none";
  error: string | null;
};
type AsrRuntime = {
  provider: "local" | "remote";
  config:
    | { provider: "local"; modelDir: string }
    | { provider: "remote"; baseUrl: string; model: string; apiKey: string }
    | undefined;
  hasKey: boolean;
  keySource: "env" | "stored" | "none";
  error: string | null;
};
let llmRuntime: LlmRuntime = { endpoint: undefined, discoveredModel: null, keySource: "none", error: null };
let asrRuntime: AsrRuntime = { provider: "local", config: undefined, hasKey: false, keySource: "none", error: null };

/** 错误与日志出口：脱敏集合 = env 两个 key + 密钥库已加载的两个 key + 两个 baseUrl，任一命中整体替换。 */
function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const secrets: (string | undefined)[] = [
    process.env.VNOTE_LLM_API_KEY,
    process.env.IDEALSOFT_API_KEY,
    process.env.VNOTE_ASR_API_KEY,
    ...(secretStore?.all() ?? []),
    settings.llm.baseUrl,
    settings.asr.remote.baseUrl,
  ];
  for (const s of secrets) {
    if (s !== undefined && s !== "" && message.includes(s)) return "内部错误（详细信息已脱敏，见日志）";
  }
  return message;
}

/** 端点发现：空 model 时后台 GET /models 自选；失败把脱敏错误留在运行时上给界面。 */
let discovery: Promise<void> | undefined;
function startDiscovery(): void {
  const llm = resolveLlm(settings, secretStore?.get("llm"), process.env);
  if (llm.value === undefined || llm.value.model !== "") return;
  const creds = llm.value;
  discovery = (async () => {
    try {
      const endpoint = await resolveLlmEndpoint(creds);
      llmRuntime.discoveredModel = endpoint.model;
    } catch (err) {
      llmRuntime.error = sanitizeError(err);
    }
  })();
}

/** 设置/密钥变更后重算两个运行时；失败时不重算，保持旧值（ADR-0015 §3）。 */
function recomputeRuntimes(): void {
  try {
    const llm = resolveLlm(settings, secretStore?.get("llm"), process.env);
    llmRuntime = {
      endpoint: llm.value !== undefined ? { baseUrl: llm.value.baseUrl, apiKey: llm.value.apiKey, model: llm.value.model } : undefined,
      discoveredModel: null,
      keySource: llm.keySource,
      error: llm.value === undefined ? (llm.missing.length > 0 ? `LLM 未配齐：${llm.missing.join("、")}` : null) : null,
    };
    const asr = resolveAsr(settings, secretStore?.get("asr"), process.env);
    asrRuntime = {
      provider: settings.asr.provider,
      config:
        asr.value === undefined
          ? undefined
          : asr.value.provider === "local"
            ? { provider: "local", modelDir: settings.modelDir }
            : { provider: "remote", baseUrl: asr.value.baseUrl, model: asr.value.model, apiKey: asr.value.apiKey },
      hasKey: asr.keySource !== "none",
      keySource: asr.keySource,
      error: asr.value === undefined ? (asr.missing.length > 0 ? `ASR 未配齐：${asr.missing.join("、")}` : null) : null,
    };
    startDiscovery();
  } catch {
    // 重算失败（设置形状异常等）：保持旧值，界面走既有状态
  }
}


type WorkerState = {
  proc: UtilityProcess;
  handle: JobHandle;
  cancelRequested: boolean;
  resultDelivered: boolean;
  killTimer: NodeJS.Timeout | undefined;
  /** prepared 回调后由 main 落下的 outputDir/runToken；终态结算用。 */
  outputDir: string | null;
  runToken: string | null;
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

/** 终态（cancelled、异常退出未交付、已交付 error）对已知 outputDir 调 recoverInterruptedRun（token 匹配才写，幂等）。 */
function recoverJob(job: JobRequest, message: string): void {
  if (job.outputDir !== null) recoverInterruptedRun(job.outputDir, job.runToken, message);
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
    outputDir: job.outputDir,
    runToken: job.runToken,
  };
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4000);
  });
  proc.on("message", (raw: unknown) => {
    if (typeof raw !== "object" || raw === null || !("type" in raw)) return;
    // prepared 在取消过滤之前处理（ADR-0015 §7）：收到就更新 job 的 outputDir 与 runToken，并回 ACK
    if (raw.type === "prepared" && "outputDir" in raw) {
      const p = raw as { type: string; videoId: string; outputDir: string; runToken: string };
      job.outputDir = p.outputDir;
      job.runToken = p.runToken;
      state.outputDir = p.outputDir;
      state.runToken = p.runToken;
      proc.postMessage({ type: "prepared-ack" });
      return;
    }
    // cancelRequested 之后丢弃 progress/done/error，终态只由 exit 事件定
    if (state.cancelRequested) return;
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
      // 已交付 error：流水线已在锁内结算过；main 侧再按 token 恢复（幂等）
      recoverJob(job, "本次生成未完成");
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
      recoverJob(job, "本次生成已取消");
      queue.cancelled(jobId);
      return;
    }
    if (state.resultDelivered) return; // done/error 已经定了终态
    // worker 异常退出且未交付结果：按 token 恢复
    recoverJob(job, "本次生成未完成");
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
    runToken: job.runToken,
    // 启动 handler 已保证配置齐全；空值兜底让 worker 自己报脱敏错误
    endpoint: job.endpoint ?? { baseUrl: "", apiKey: "", model: "" },
    asr: job.asr ?? { provider: "local", modelDir: job.config.modelDir },
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
    importedAt: v.importedAt,
    sizeBytes: v.sizeBytes,
    resolution: v.resolution,
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
    asrEngine: "asrEngine" in raw ? (raw.asrEngine ?? null) : null,
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

/** 入队前的门禁（ADR-0015 §4/§7）：等端点发现、LLM 配齐、本地 ASR 模型 ready、队列为空。 */
async function ensurePipelineReady(): Promise<void> {
  if (discovery !== undefined) await discovery;
  if (llmRuntime.endpoint === undefined) {
    throw new Error("未配置 LLM 端点：请在设置里保存 base url 与 api key，或用环境变量配置");
  }
  if (llmRuntime.endpoint.model === "" && llmRuntime.discoveredModel === null) {
    throw new Error(`模型发现失败：请在设置里显式指定 model（${llmRuntime.error ?? "未知原因"}）`);
  }
  if (settings.asr.provider === "local") {
    const status = modelStatus(settings.modelDir);
    if (!status.ready) {
      const bad = status.bundles.filter((b) => b.state !== "ready").map((b) => b.title).join("、");
      throw new Error(`本地 ASR 模型${bad === "" ? "未就绪" : `未就绪（${bad}）`}：请在设置页下载、导入或校验模型`);
    }
  }
  if (queue.busy()) throw new Error("已有任务在运行，请等它结束再开始");
}

/** 组一个完整任务：runToken 入队时生成，endpoint/asr 按当前运行时冻结。 */
function buildJobRequest(kind: JobKind, videoId: string, sourcePath: string, outputDir: string | null, topicIds?: string[]): JobRequest {
  return {
    kind,
    videoId,
    sourcePath,
    outputDir,
    runToken: randomUUID(),
    endpoint: llmRuntime.endpoint ?? { baseUrl: "", apiKey: "", model: "" },
    asr: asrRuntime.config ?? { provider: "local", modelDir: settings.modelDir },
    config: { notesRoot: settings.notesRoot, cacheRoot: settings.cacheRoot, modelDir: settings.modelDir },
    ...(topicIds !== undefined ? { topicIds } : {}),
  };
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
  return { jobId: queue.enqueue(buildJobRequest("extract", videoId, sourcePath, outputDir)) };
}

async function startNotes(videoId: string, topicIds: string[]): Promise<{ jobId: string }> {
  await ensurePipelineReady();
  const entry = resolveVideo(videoId);
  if (topicIds.length === 0) throw new Error("请先勾选要生成的主题");
  return { jobId: queue.enqueue(buildJobRequest("notes", videoId, entry.sourcePath ?? "", entry.outputDir, topicIds)) };
}

async function rebuildTopics(videoId: string): Promise<{ jobId: string }> {
  await ensurePipelineReady();
  const entry = resolveVideo(videoId);
  return { jobId: queue.enqueue(buildJobRequest("topics", videoId, entry.sourcePath ?? "", entry.outputDir)) };
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
  const baseUrl = llmRuntime.endpoint?.baseUrl ?? settings.llm.baseUrl;
  return {
    configured: llmRuntime.endpoint !== undefined,
    baseUrl: baseUrl === "" ? null : displayUrl(baseUrl),
    model: settings.llm.model === "" ? null : settings.llm.model,
    discoveredModel: llmRuntime.discoveredModel,
    hasKey: llmRuntime.keySource !== "none",
    keySource: llmRuntime.keySource,
    keyStorageAvailable: secretStore?.available() ?? false,
    locked: { baseUrl: locked.llmBaseUrl, model: locked.llmModel },
    error: llmRuntime.error,
  };
}

function displayUrl(value: string): string {
  try {
    const u = new URL(value);
    return `${u.origin}${u.pathname === "" ? "/" : u.pathname}`;
  } catch {
    return value;
  }
}

function modelsStatusDto(): ModelsStatus {
  return modelsDownloader.status(settings.modelDir);
}

async function settingsStatus(): Promise<SettingsStatus> {
  if (discovery !== undefined) await discovery;
  const ff = ffmpegProbe();
  const models = modelsStatusDto();
  return {
    notesRoot: settings.notesRoot,
    cacheRoot: settings.cacheRoot,
    modelDir: settings.modelDir,
    cacheBytes: cacheUsage(settings.cacheRoot).bytes,
    llm: llmStatus(),
    asr: asrStatusDto(),
    models: { ready: models.ready, totalBytes: models.totalBytes, presentBytes: models.presentBytes, autoDownloadDisabled: models.autoDownloadDisabled },
    settingsFileError: txError !== null ? txError : (settingsFileError ?? secretStore?.error() ?? null),
    ffmpeg: ff.ok,
    ffmpegVersion: ff.version,
    locked: {
      notesRoot: locked.notesRoot,
      cacheRoot: locked.cacheRoot,
      modelDir: locked.modelDir,
      llmBaseUrl: locked.llmBaseUrl,
      llmModel: locked.llmModel,
      asrProvider: locked.asrProvider,
      asrBaseUrl: locked.asrBaseUrl,
      asrModel: locked.asrModel,
    },
    appVersion: app.getVersion(),
  };
}

function asrStatusDto(): SettingsStatus["asr"] {
  const local = modelStatus(settings.modelDir);
  const remote = resolveAsr(settings, secretStore?.get("asr"), process.env);
  return {
    provider: settings.asr.provider,
    providerLocked: locked.asrProvider,
    local: { modelId: ASR_MODEL_ID, ready: local.ready, missing: local.bundles.filter((b) => b.state !== "ready").map((b) => b.title) },
    remote: {
      baseUrl: settings.asr.remote.baseUrl === "" ? "" : displayUrl(settings.asr.remote.baseUrl),
      model: settings.asr.remote.model,
      hasKey: asrRuntime.keySource !== "none",
      keySource: asrRuntime.keySource,
      keyStorageAvailable: secretStore?.available() ?? false,
      locked: { baseUrl: locked.asrBaseUrl, model: locked.asrModel },
      error: asrRuntime.error,
    },
  };
}

// 白名单重建抽在 settings-patch.ts（不 import electron，main 侧测试可直接加载）
import { buildSettingsPatch } from "./settings-patch";
export { buildSettingsPatch };

async function updateSettings(patch: SettingsPatch): Promise<SettingsStatus> {
  return withSettingsWrite(async () => {
    if (patch.modelDir !== undefined && modelsDownloader.busy()) {
      throw new Error("模型正在下载中，请完成后再修改模型目录");
    }
    const clean = buildSettingsPatch(patch);
    settings = saveSettings(SETTINGS_PATH(), clean);
    recomputeRuntimes();
    return settingsStatus();
  });
}

async function pickDirectory(kind: DirectoryKind): Promise<string | null> {
  // 模型目录选目录；notes/cache 选文件（视频）+ 目录兜底
  if (kind === "model") {
    const res = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  }
  const res = await dialog.showOpenDialog({ properties: ["openFile", "openDirectory"] });
  return res.canceled ? null : (res.filePaths[0] ?? null);
}

function clearCacheNow(): { freedBytes: number } {
  return { freedBytes: clearCache(settings.cacheRoot, listLibrary(settings.notesRoot).map((v) => v.outputDir)) };
}

async function testLlm(): Promise<TestLlmResult> {
  if (llmRuntime.endpoint === undefined) {
    return { ok: false, model: null, message: `未配置 LLM 端点：${llmRuntime.error ?? "请在设置里保存 base url 与 api key"}` };
  }
  const ep = llmRuntime.endpoint;
  const url = `${ep.baseUrl.replace(/\/$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${ep.apiKey}` },
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

function requireStore(): SecretStore {
  if (secretStore === undefined) throw new Error("密钥存储尚未就绪，请稍后再试");
  return secretStore;
}

async function updateLlm(patch: LlmUpdatePatch): Promise<SettingsStatus> {
  return withSettingsWrite(() => {
    settings = commitCredentialUpdate({
      userData: app.getPath("userData"),
      settingsFile: SETTINGS_PATH(),
      codec: electronCodec,
      secretStore: requireStore(),
      settingsPatch: { llm: { baseUrl: patch.baseUrl, model: patch.model } },
      secret: { id: "llm", patch: { apiKey: patch.apiKey, clearApiKey: patch.clearApiKey } },
    });
    recomputeRuntimes();
    return settingsStatus();
  });
}

async function updateAsr(patch: AsrUpdatePatch): Promise<SettingsStatus> {
  return withSettingsWrite(() => {
    settings = commitCredentialUpdate({
      userData: app.getPath("userData"),
      settingsFile: SETTINGS_PATH(),
      codec: electronCodec,
      secretStore: requireStore(),
      settingsPatch: { asr: { provider: patch.provider, remote: patch.remote } },
      secret: { id: "asr", patch: { apiKey: patch.apiKey, clearApiKey: patch.clearApiKey } },
    });
    recomputeRuntimes();
    return settingsStatus();
  });
}

/** 本地：检查 4 个包；远程：只 GET /models 证明鉴权与列表可达（不代表能转写，ADR-0015 §8）。 */
async function testAsr(): Promise<TestAsrResult> {
  if (settings.asr.provider === "local") {
    const status = modelStatus(settings.modelDir);
    const ready = status.bundles.filter((b) => b.state === "ready").length;
    return ready === status.bundles.length
      ? { ok: true, modelsFound: ready, message: "本地模型已全部就绪" }
      : { ok: false, modelsFound: ready, message: `本地模型缺 ${status.bundles.length - ready}/${status.bundles.length} 包，请在设置页下载或导入` };
  }
  const asr = resolveAsr(settings, secretStore?.get("asr"), process.env);
  if (asr.value === undefined) return { ok: false, modelsFound: null, message: `ASR 未配齐（${asr.missing.join("、")}）` };
  const remote = asr.value;
  if (remote.provider !== "remote") return { ok: false, modelsFound: null, message: "ASR 未配置为远程" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${remote.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${remote.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, modelsFound: null, message: `连接失败：HTTP ${res.status}` };
    return { ok: true, modelsFound: null, message: "连接成功，鉴权与模型列表可达（不代表能转写）" };
  } catch (err) {
    return { ok: false, modelsFound: null, message: sanitizeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

function modelsStatusNow(): ModelsStatus {
  return modelsDownloader.status(settings.modelDir);
}

async function downloadModelsNow(): Promise<ModelsStatus> {
  if (queue.busy()) throw new Error("已有任务在运行，完成后再安装模型");
  if (modelsDownloader.busy()) return modelsStatusNow();
  modelsDownloader.start(settings.modelDir, {
    onSnapshot: (s) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.modelEvent, s);
    },
    busy: () => queue.busy(),
  });
  return modelsStatusNow();
}

function cancelModelDownload(): ModelsStatus {
  modelsDownloader.cancel();
  return modelsStatusNow();
}

/** 导入在模型锁内跑（core importModels 不取锁，写方入口持锁，ADR-0015 §4）。 */
async function importModelsNow(): Promise<ImportModelsResult> {
  if (queue.busy()) throw new Error("已有任务在运行，完成后再导入模型");
  const res = await dialog.showOpenDialog({ properties: ["openFile", "openDirectory"], title: "选择模型目录或 .tar.bz2 归档" });
  if (res.canceled || res.filePaths[0] === undefined) return { canceled: true, installed: [], rejected: [], status: modelsStatusNow() };
  const lock = acquireModelLock(settings.modelDir);
  try {
    const r = await importModels(settings.modelDir, res.filePaths[0]);
    return { canceled: false, installed: r.installed, rejected: r.rejected, status: modelsStatusNow() };
  } finally {
    lock.release();
  }
}

async function verifyModelsNow(): Promise<ModelsStatus> {
  const lock = acquireModelLock(settings.modelDir);
  try {
    await verifyModels(settings.modelDir);
    return modelsStatusNow();
  } finally {
    lock.release();
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

/** 首次启动自动下载（ADR-0015 §4）：本地、未 ready、未尝试过、VNOTE_DISABLE_MODEL_DOWNLOAD!=1 才启动；先 markAutoDownloadAttempted。 */
function maybeAutoDownload(): void {
  if (settings.asr.provider !== "local") return;
  if (process.env.VNOTE_DISABLE_MODEL_DOWNLOAD === "1") return;
  if (settings.asr.autoDownloadAttemptedAt !== null) return;
  if (modelStatus(settings.modelDir).ready) return;
  settings = markAutoDownloadAttempted(SETTINGS_PATH(), new Date().toISOString());
  modelsDownloader.start(settings.modelDir, {
    onSnapshot: (s) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.modelEvent, s);
    },
    busy: () => queue.busy(),
  });
}

let quitting = false;
app.on("before-quit", (event) => {
  // 退出前：停下载器（最多等 2s 刷盘）+ 取消运行中任务并等 worker 退出（ADR-0015 §4）
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void modelsDownloader.stop();
  if (queue.busy()) {
    queue.cancelAll();
    const forceQuit = setTimeout(() => {
      for (const w of workers.values()) w.handle.kill();
      app.quit();
    }, 5000);
    void queue.drain().then(() => {
      clearTimeout(forceQuit);
      app.quit();
    });
  } else {
    app.quit();
  }
});
app.on("window-all-closed", () => {
  app.quit();
});

void app.whenReady().then(async () => {
  // 启动顺序（ADR-0015 §3）：密钥库 → 重放 pending → 重算运行时 → 首次自动下载
  secretStore = createSecretStore({ file: join(app.getPath("userData"), "secrets.bin"), codec: electronCodec });
  txError = replayCredentialTransaction({
    userData: app.getPath("userData"),
    settingsFile: SETTINGS_PATH(),
    codec: electronCodec,
    secretStore,
  });
  if (txError !== null) console.warn(sanitizeError(new Error(txError)));
  recomputeRuntimes();
  maybeAutoDownload();

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
  ipcMain.handle(IPC.updateLlm, guard((_e, patch: LlmUpdatePatch) => updateLlm(patch)));
  ipcMain.handle(IPC.updateAsr, guard((_e, patch: AsrUpdatePatch) => updateAsr(patch)));
  ipcMain.handle(IPC.pickDirectory, guard((_e, kind: DirectoryKind) => pickDirectory(kind)));
  ipcMain.handle(IPC.clearCache, guard(() => clearCacheNow()));
  ipcMain.handle(IPC.testLlm, guard(() => testLlm()));
  ipcMain.handle(IPC.testAsr, guard(() => testAsr()));
  ipcMain.handle(IPC.models, guard(() => modelsStatusNow()));
  ipcMain.handle(IPC.downloadModels, guard(() => downloadModelsNow()));
  ipcMain.handle(IPC.cancelModelDownload, guard(() => cancelModelDownload()));
  ipcMain.handle(IPC.importModels, guard(() => importModelsNow()));
  ipcMain.handle(IPC.verifyModels, guard(() => verifyModelsNow()));
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
