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
  asrEnv,
  resolveAsrFor,
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
  VOLCENGINE_STANDARD_RESOURCE_ID,
  VOLCENGINE_STANDARD_SUBMIT_URL,
} from "@video-notes/core";
import { createVolcengineFlashProvider } from "../../../../packages/core/src/asr/providers/volcengine";
import type {
  AppSettings,
  AsrSecrets,
  CorrectionFileEntry,
  KeySource,
  LibraryDetail as CoreLibraryDetail,
  LibraryVideo as CoreLibraryVideo,
  LlmEndpoint,
  SettingsPatch as CoreSettingsPatch,
  VideoRef,
  VolcengineAuth,
} from "@video-notes/core";
import {
  IPC,
  type AsrSecretField,
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
import { createSecretStore, type SecretCodec, type SecretId, type SecretStore } from "./secrets";
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

// .env 加载之后才读这两个变量：Finder 启动的进程没有 shell 的 env，靠 <cwd>/.env 与 <notes 根>/.env 提供（ADR-0009）。
// 打包后从 Finder 启动的 GUI 进程拿到的是 launchd 的最小 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
// Homebrew 的 ffmpeg/ffprobe 不在里面。这里把常见安装位置补到 PATH 最前，供 core 的 spawn 与 ffmpegProbe 使用。
// VNOTE_FFMPEG_DIR 可显式指定（自定义安装或测试）。
const TOOL_DIRS = [
  process.env.VNOTE_FFMPEG_DIR,
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].filter((dir): dir is string => dir !== undefined && dir !== "");
process.env.PATH = `${TOOL_DIRS.join(":")}:${process.env.PATH ?? ""}`;

/**
 * 云端 ASR 开关（r26）：未签名试用版只启用本地 sherpa-onnx，云端提供方（OpenAI 兼容 / 火山）不暴露。
 * 设置文件里的 provider 仍按原样读写（r24 代码保留），但运行时一律求值为 local。
 */
const CLOUD_ASR_ENABLED = process.env.VNOTE_ENABLE_CLOUD_ASR === "1";
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
let secretStore: SecretStore | undefined;
/** pending 事务门禁（ADR-0016 §5 硬规则 2）：非 null 时不发布运行时、不端点发现，拒绝入队与连接测试。 */
let credentialTxError: string | null = null;
/** 重放成功后解除门禁；失败保持门禁（commitCredentialUpdate 内部先重放旧 pending）。 */
function clearTxAfterCommit(): void {
  const err = replayCredentialTransaction({
    userData: app.getPath("userData"),
    settingsFile: SETTINGS_PATH(),
    codec: electronCodec,
    secretStore: requireStore(),
  });
  if (err === null) credentialTxError = null;
}

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
  /** 已配齐 base url 与 key 的凭据；连接测试只用它，不要求 model 已解析。 */
  credentials: { baseUrl: string; apiKey: string } | undefined;
  /** 可交给 worker 的端点：credentials + 非空 model；model 留空时等发现填好才出现（r26）。 */
  endpoint: LlmEndpoint | undefined;
  discoveredModel: string | null;
  keySource: "env" | "stored" | "none";
  error: string | null;
};
type AsrRuntime = {
  provider: "local" | "openai" | "volcengine";
  config:
    | { provider: "local"; modelDir: string }
    | { provider: "openai"; baseUrl: string; model: string; apiKey: string }
    | { provider: "volcengine"; mode: "flash" | "standard"; auth: VolcengineAuth }
    | undefined;
  hasKey: boolean;
  keySource: "env" | "stored" | "none";
  error: string | null;
};
let llmRuntime: LlmRuntime = { credentials: undefined, endpoint: undefined, discoveredModel: null, keySource: "none", error: null };
let asrRuntime: AsrRuntime = { provider: "local", config: undefined, hasKey: false, keySource: "none", error: null };

/** 运行时实际使用的 ASR 提供方：云端开关关闭时恒为 local（r26）。 */
function effectiveAsrProvider(): "local" | "openai" | "volcengine" {
  return CLOUD_ASR_ENABLED ? settings.asr.provider : "local";
}

/** 错误与日志出口：脱敏集合 = env 的 key 变量 + 密钥库全部值 + 两个 baseUrl，任一命中整体替换（ADR-0016 §7.1）。 */
function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const secrets: (string | undefined)[] = [
    process.env.VNOTE_LLM_API_KEY,
    process.env.IDEALSOFT_API_KEY,
    process.env.VNOTE_ASR_API_KEY,
    process.env.VNOTE_VOLC_API_KEY,
    process.env.VOLC_ASR_API_KEY,
    process.env.VNOTE_VOLC_APP_KEY,
    process.env.VNOTE_VOLC_ACCESS_KEY,
    ...(secretStore?.all() ?? []),
    settings.llm.baseUrl,
    settings.asr.openai.baseUrl,
  ];
  for (const s of secrets) {
    if (s !== undefined && s !== "" && message.includes(s)) return "内部错误（详细信息已脱敏，见日志）";
  }
  return message;
}

/**
 * 端点发现：model 留空时后台 GET /models 自选；失败把脱敏错误留在运行时上给界面。门禁期间不启动（ADR-0016 §5 硬规则 2）。
 * 结果直接替换 `llmRuntime.endpoint`：空 model 只是「等发现」的中间态，不能流到 worker（r26）。
 * 世代号让迟到的旧凭据结果不覆盖新设置。
 */
let discovery: Promise<void> | undefined;
let discoveryGeneration = 0;
function startDiscovery(): void {
  // 每次重算都先作废上一次发现：显式钉了 model、凭据不全或门禁中都不该让迟到的旧结果落回来
  const generation = ++discoveryGeneration;
  discovery = undefined;
  if (credentialTxError !== null) return;
  const llm = resolveLlm(settings, secretStore?.get("llm"), process.env);
  if (llm.value === undefined || llm.value.model !== "") return;
  const creds = llm.value;
  discovery = (async () => {
    try {
      const endpoint = await resolveLlmEndpoint(creds);
      if (generation !== discoveryGeneration) return;
      llmRuntime.endpoint = endpoint;
      llmRuntime.discoveredModel = endpoint.model;
    } catch (err) {
      if (generation !== discoveryGeneration) return;
      llmRuntime.error = sanitizeError(err);
    }
    // 设置页靠这条事件把「留空时自动发现」换成发现结果，不必切页面重挂载
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.llmEvent);
  })();
}

/** 可交给 worker 的 LLM 端点：baseUrl、key、非空 model 三者齐备，否则带原因抛错。 */
async function requireLlmEndpoint(): Promise<LlmEndpoint> {
  if (discovery !== undefined) await discovery;
  const endpoint = llmRuntime.endpoint;
  // 发布出来的 endpoint 一定带非空 model；「有凭据但没有 endpoint」只可能是发现失败
  if (endpoint !== undefined) return endpoint;
  if (llmRuntime.credentials !== undefined) {
    throw new Error(`模型发现失败：请在设置里显式指定 model（${llmRuntime.error ?? "未知原因"}）`);
  }
  throw new Error("未配置 LLM 端点：请在设置里保存 base url 与 api key，或用环境变量配置");
}

/** 设置/密钥变更后重算两个运行时；失败时不重算，保持旧值（ADR-0015 §3）。 */
function asrSecrets(): AsrSecrets {
  const store = secretStore;
  if (store === undefined) return {};
  return {
    openai: store.get("asr"),
    volcApiKey: store.get("volcApiKey"),
    volcAppKey: store.get("volcAppKey"),
    volcAccessKey: store.get("volcAccessKey"),
  };
}
function recomputeRuntimes(): void {
  if (credentialTxError !== null) {
    // 门禁：不发布解析结果与端点发现，运行时置为未配置（ADR-0016 §5 硬规则 2）
    llmRuntime = { credentials: undefined, endpoint: undefined, discoveredModel: null, keySource: "none", error: credentialTxError };
    asrRuntime = { provider: effectiveAsrProvider(), config: undefined, hasKey: false, keySource: "none", error: credentialTxError };
    return;
  }
  try {
    const llm = resolveLlm(settings, secretStore?.get("llm"), process.env);
    // model 留空时 endpoint 先不发布：空 model 是「等发现」的中间态，discovery 成功后才补上（r26）
    llmRuntime = {
      credentials: llm.value !== undefined ? { baseUrl: llm.value.baseUrl, apiKey: llm.value.apiKey } : undefined,
      endpoint: llm.value !== undefined && llm.value.model !== "" ? { baseUrl: llm.value.baseUrl, apiKey: llm.value.apiKey, model: llm.value.model } : undefined,
      discoveredModel: null,
      keySource: llm.keySource,
      error: llm.value === undefined ? (llm.missing.length > 0 ? `LLM 未配齐：${llm.missing.join("、")}` : null) : null,
    };
    const provider = effectiveAsrProvider();
    const asr = resolveAsrFor(settings, provider, asrSecrets(), process.env);
    asrRuntime = {
      provider,
      config:
        asr.value === undefined
          ? undefined
          : asr.value.provider === "local"
            ? { provider: "local", modelDir: settings.modelDir }
            : asr.value.provider === "openai"
              ? { provider: "openai", baseUrl: asr.value.baseUrl, model: asr.value.model, apiKey: asr.value.apiKey }
              : { provider: "volcengine", mode: asr.value.mode, auth: asr.value.auth },
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
  // 结束 worker 进程本身不会带走它 spawn 的 ffmpeg/ffprobe，按父 pid 补杀一层
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
    asr: job.asr,
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

/** 入队前的门禁（ADR-0015 §4/§7、ADR-0016 §5 硬规则 2）：pending 门禁、等端点发现、LLM 配齐、火山标准版+本地视频静态拒绝、ASR 配齐、本地模型 ready、队列为空。 */
async function ensurePipelineReady(): Promise<void> {
  if (credentialTxError !== null) throw new Error(credentialTxError);
  await requireLlmEndpoint();
  // 火山标准版只收公网 URL，本地视频路径永远不可用（ADR-0016 §6）
  const provider = effectiveAsrProvider();
  if (provider === "volcengine" && settings.asr.volcengine.mode === "standard") {
    throw new Error("火山标准版只接受公网 URL；本地视频请改用极速版或本地 ASR");
  }
  if (provider !== "local" && asrRuntime.config === undefined) {
    throw new Error(asrRuntime.error ?? "ASR 未配齐，请在设置页补全");
  }
  if (provider === "local") {
    if (autoVerify !== undefined) await autoVerify;
    const status = modelStatus(settings.modelDir);
    if (!status.ready) {
      const bad = status.bundles.filter((b) => b.state !== "ready").map((b) => b.title).join("、");
      throw new Error(`本地 ASR 模型${bad === "" ? "未就绪" : `未就绪（${bad}）`}：请在设置页下载、导入或校验模型`);
    }
  }
  if (queue.busy()) throw new Error("已有任务在运行，请等它结束再开始");
}

/** 组一个完整任务：runToken 入队时生成，endpoint/asr 按当前运行时冻结；ASR 未配齐直接抛错，不回退本地（ADR-0016 §6）。 */
async function buildJobRequest(kind: JobKind, videoId: string, sourcePath: string, outputDir: string | null, topicIds?: string[]): Promise<JobRequest> {
  const asrConfig = asrRuntime.config;
  if (asrConfig === undefined) throw new Error(asrRuntime.error ?? "ASR 未配齐，请在设置页补全");
  return {
    kind,
    videoId,
    sourcePath,
    outputDir,
    runToken: randomUUID(),
    endpoint: await requireLlmEndpoint(),
    asr: asrConfig,
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
  return { jobId: queue.enqueue(await buildJobRequest("extract", videoId, sourcePath, outputDir)) };
}

async function startNotes(videoId: string, topicIds: string[]): Promise<{ jobId: string }> {
  await ensurePipelineReady();
  const entry = resolveVideo(videoId);
  if (topicIds.length === 0) throw new Error("请先勾选要生成的主题");
  return { jobId: queue.enqueue(await buildJobRequest("notes", videoId, entry.sourcePath ?? "", entry.outputDir, topicIds)) };
}

async function rebuildTopics(videoId: string): Promise<{ jobId: string }> {
  await ensurePipelineReady();
  const entry = resolveVideo(videoId);
  return { jobId: queue.enqueue(await buildJobRequest("topics", videoId, entry.sourcePath ?? "", entry.outputDir)) };
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
  const baseUrl = llmRuntime.credentials?.baseUrl ?? settings.llm.baseUrl;
  return {
    configured: llmRuntime.credentials !== undefined,
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
    settingsFileError: credentialTxError !== null ? credentialTxError : (settingsFileError ?? secretStore?.error() ?? null),
    features: { cloudAsr: CLOUD_ASR_ENABLED },
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
      volcMode: locked.volcMode,
      volcAuthMode: locked.volcAuthMode,
    },
    appVersion: app.getVersion(),
  };
}

/** 单个凭据字段的来源：只 env 提供是 env，只密钥库保存是 stored（ADR-0016 §9，逐字段独立于整套 Resolution.keySource）。 */
function credentialFieldSource(envValue: string | undefined, stored: string | undefined): KeySource {
  if (envValue !== undefined) return "env";
  if (stored !== undefined && stored !== "") return "stored";
  return "none";
}
function asrStatusDto(): SettingsStatus["asr"] {
  const local = modelStatus(settings.modelDir);
  const env = asrEnv(process.env);
  const secrets = asrSecrets();
  const openaiResolution = resolveAsrFor(settings, "openai", secrets, process.env);
  const volcResolution = resolveAsrFor(settings, "volcengine", secrets, process.env);
  const openaiKeyStored = secrets.openai;
  return {
    provider: effectiveAsrProvider(),
    providerLocked: locked.asrProvider,
    local: { modelId: ASR_MODEL_ID, ready: local.ready, missing: local.bundles.filter((b) => b.state !== "ready").map((b) => b.title) },
    openai: {
      baseUrl: settings.asr.openai.baseUrl === "" ? "" : displayUrl(settings.asr.openai.baseUrl),
      model: settings.asr.openai.model,
      hasKey: env.apiKey !== undefined || (openaiKeyStored !== undefined && openaiKeyStored !== ""),
      keySource: credentialFieldSource(env.apiKey, openaiKeyStored),
      keyStorageAvailable: secretStore?.available() ?? false,
      locked: { baseUrl: locked.asrBaseUrl, model: locked.asrModel },
      error: credentialTxError !== null ? credentialTxError : openaiResolution.value === undefined && openaiResolution.missing.length > 0 ? `ASR 未配齐：${openaiResolution.missing.join("、")}` : null,
    },
    volcengine: {
      mode: settings.asr.volcengine.mode,
      modeLocked: locked.volcMode,
      authMode: settings.asr.volcengine.authMode,
      authModeLocked: locked.volcAuthMode,
      apiKey: {
        hasKey: env.volcApiKey !== undefined || (secrets.volcApiKey !== undefined && secrets.volcApiKey !== ""),
        keySource: credentialFieldSource(env.volcApiKey, secrets.volcApiKey),
        keyStorageAvailable: secretStore?.available() ?? false,
      },
      appKey: {
        hasKey: env.volcAppKey !== undefined || (secrets.volcAppKey !== undefined && secrets.volcAppKey !== ""),
        keySource: credentialFieldSource(env.volcAppKey, secrets.volcAppKey),
        keyStorageAvailable: secretStore?.available() ?? false,
      },
      accessKey: {
        hasKey: env.volcAccessKey !== undefined || (secrets.volcAccessKey !== undefined && secrets.volcAccessKey !== ""),
        keySource: credentialFieldSource(env.volcAccessKey, secrets.volcAccessKey),
        keyStorageAvailable: secretStore?.available() ?? false,
      },
      error: credentialTxError !== null ? credentialTxError : volcResolution.value === undefined && volcResolution.missing.length > 0 ? `ASR 未配齐：${volcResolution.missing.join("、")}` : null,
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
    if (clean.asr?.provider !== undefined && clean.asr.provider !== "local" && !CLOUD_ASR_ENABLED) {
      throw new Error("此版本只启用本地 ASR，云端提供方不可用");
    }
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
  if (credentialTxError !== null) return { ok: false, model: null, message: credentialTxError };
  // 连接测试只验证凭据与网络：model 还没发现成功时也要能测（r26 的诊断曾因此误报「未配置」）
  const creds = llmRuntime.credentials;
  if (creds === undefined) {
    return { ok: false, model: null, message: `未配置 LLM 端点：${llmRuntime.error ?? "请在设置里保存 base url 与 api key"}` };
  }
  const url = `${creds.baseUrl.replace(/\/$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
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
  if (credentialTxError !== null) throw new Error(credentialTxError);
  return withSettingsWrite(() => {
    settings = commitCredentialUpdate({
      userData: app.getPath("userData"),
      settingsFile: SETTINGS_PATH(),
      codec: electronCodec,
      secretStore: requireStore(),
      settingsPatch: { llm: { baseUrl: patch.baseUrl, model: patch.model } },
      secret: { id: "llm", patch: { apiKey: patch.apiKey, clearApiKey: patch.clearApiKey } },
    });
    clearTxAfterCommit();
    recomputeRuntimes();
    return settingsStatus();
  });
}

/** secret.field 到 SecretId 的映射（ADR-0016 §9）：renderer 不发 store 内部 id。 */
const ASR_SECRET_FIELD_TO_ID: Record<AsrSecretField, SecretId> = {
  openaiKey: "asr",
  volcApiKey: "volcApiKey",
  volcAppKey: "volcAppKey",
  volcAccessKey: "volcAccessKey",
};
const ASR_SECRET_FIELD_ENV: Record<AsrSecretField, () => string | undefined> = {
  openaiKey: () => asrEnv(process.env).apiKey,
  volcApiKey: () => asrEnv(process.env).volcApiKey,
  volcAppKey: () => asrEnv(process.env).volcAppKey,
  volcAccessKey: () => asrEnv(process.env).volcAccessKey,
};
const ASR_SECRET_FIELD_LABEL: Record<AsrSecretField, string> = {
  openaiKey: "OpenAI API key",
  volcApiKey: "火山 API Key",
  volcAppKey: "火山 App Key",
  volcAccessKey: "火山 Access Key",
};
async function updateAsr(patch: AsrUpdatePatch): Promise<SettingsStatus> {
  if (credentialTxError !== null) throw new Error(credentialTxError);
  return withSettingsWrite(() => {
    const asrOut: NonNullable<CoreSettingsPatch["asr"]> = {};
    if (patch.provider !== undefined) {
      if (patch.provider !== "local" && patch.provider !== "openai" && patch.provider !== "volcengine") {
        throw new Error(`设置 asr.provider 必须是 local / openai / volcengine，实际是 ${JSON.stringify(patch.provider)}`);
      }
      // r26：试用版只启用本地 ASR，云端提供方连写入都拒绝，避免界面隐藏后仍有第二条路径
      if (patch.provider !== "local" && !CLOUD_ASR_ENABLED) {
        throw new Error("此版本只启用本地 ASR，云端提供方不可用");
      }
      asrOut.provider = patch.provider;
    }
    if (patch.openai !== undefined) {
      asrOut.openai = {};
      if (patch.openai.baseUrl !== undefined) asrOut.openai.baseUrl = patch.openai.baseUrl;
      if (patch.openai.model !== undefined) asrOut.openai.model = patch.openai.model;
    }
    if (patch.volcengine !== undefined) {
      asrOut.volcengine = {};
      if (patch.volcengine.mode !== undefined) {
        if (patch.volcengine.mode !== "flash" && patch.volcengine.mode !== "standard") {
          throw new Error(`设置 asr.volcengine.mode 必须是 flash / standard，实际是 ${JSON.stringify(patch.volcengine.mode)}`);
        }
        asrOut.volcengine.mode = patch.volcengine.mode;
      }
      if (patch.volcengine.authMode !== undefined) {
        if (patch.volcengine.authMode !== "apiKey" && patch.volcengine.authMode !== "appAccessKey") {
          throw new Error(`设置 asr.volcengine.authMode 必须是 apiKey / appAccessKey，实际是 ${JSON.stringify(patch.volcengine.authMode)}`);
        }
        asrOut.volcengine.authMode = patch.volcengine.authMode;
      }
    }
    // 一次只改一个密钥：field 必填，value 与 clear 同传拒绝，空值按 clear（ADR-0016 §5）
    const secretId: SecretId | undefined = patch.secret?.field === undefined
      ? undefined
      : patch.secret.field in ASR_SECRET_FIELD_TO_ID
        ? ASR_SECRET_FIELD_TO_ID[patch.secret.field]
        : undefined;
    if (patch.secret !== undefined && secretId === undefined) {
      throw new Error(`密钥字段必须是 openaiKey / volcApiKey / volcAppKey / volcAccessKey，实际是 ${JSON.stringify(patch.secret.field)}`);
    }
    let secretPatch: { apiKey?: string; clearApiKey?: boolean } = {};
    if (secretId !== undefined) {
      if (patch.secret !== undefined && patch.secret.value !== undefined && patch.secret.clear === true) {
        throw new Error("不能同时保存和清除密钥");
      }
      if (patch.secret !== undefined && patch.secret.value === undefined && patch.secret.clear !== true) {
        throw new Error("密钥更新必须传 value 或 clear 之一");
      }
      if (patch.secret !== undefined && patch.secret.value !== undefined && ASR_SECRET_FIELD_ENV[patch.secret.field]() !== undefined) {
        throw new Error(`${ASR_SECRET_FIELD_LABEL[patch.secret.field]} 由环境变量控制，请用环境变量修改`);
      }
      if (patch.secret !== undefined && patch.secret.clear === true) {
        secretPatch = { clearApiKey: true };
      } else if (patch.secret !== undefined && patch.secret.value !== undefined) {
        secretPatch = { apiKey: patch.secret.value === "" ? "" : patch.secret.value };
        if (patch.secret.value === "") secretPatch = { clearApiKey: true };
      }
    }
    settings = commitCredentialUpdate({
      userData: app.getPath("userData"),
      settingsFile: SETTINGS_PATH(),
      codec: electronCodec,
      secretStore: requireStore(),
      settingsPatch: Object.keys(asrOut).length > 0 ? { asr: asrOut } : {},
      secret: { id: secretId ?? "asr", patch: secretPatch },
    });
    clearTxAfterCommit();
    recomputeRuntimes();
    return settingsStatus();
  });
}

/** 本地：检查 4 个包；OpenAI：GET /models；火山极速版：1 秒静音 WAV；火山标准版：官方示例 URL 提交一次（不轮询）。 */
async function testAsr(): Promise<TestAsrResult> {
  if (credentialTxError !== null) return { ok: false, modelsFound: null, message: credentialTxError };
  if (effectiveAsrProvider() === "local") {
    if (autoVerify !== undefined) await autoVerify;
    const status = modelStatus(settings.modelDir);
    const ready = status.bundles.filter((b) => b.state === "ready").length;
    return ready === status.bundles.length
      ? { ok: true, modelsFound: ready, message: "本地模型已全部就绪" }
      : { ok: false, modelsFound: ready, message: `本地模型缺 ${status.bundles.length - ready}/${status.bundles.length} 包，请在设置页下载或导入` };
  }
  const asr = resolveAsrFor(settings, effectiveAsrProvider(), asrSecrets(), process.env);
  if (asr.value === undefined) return { ok: false, modelsFound: null, message: `ASR 未配齐（${asr.missing.join("、")}）` };
  const resolved = asr.value;
  try {
    if (resolved.provider === "openai") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(`${resolved.baseUrl.replace(/\/$/, "")}/models`, {
          headers: { Authorization: `Bearer ${resolved.apiKey}` },
          signal: controller.signal,
        });
        if (!res.ok) return { ok: false, modelsFound: null, message: `连接失败：HTTP ${res.status}` };
        return { ok: true, modelsFound: null, message: "连接成功，鉴权与模型列表可达（不代表能转写）" };
      } finally {
        clearTimeout(timer);
      }
    }
    if (resolved.provider !== "volcengine") {
      return { ok: false, modelsFound: null, message: "ASR 提供方状态异常，请在设置里重新选择" };
    }
    if (resolved.mode === "flash") {
      // 1 秒 16k 单声道 16-bit 静音 WAV（32 KB），远离空音频判定边界（ADR-0016 §9）
      const seconds = 1;
      const rate = 16_000;
      const pcm = new Uint8Array(seconds * rate * 2);
      const wav = new Uint8Array(44 + pcm.byteLength);
      const dv = new DataView(wav.buffer);
      dv.setUint32(0, 0x46465252, true); // RIFF
      dv.setUint32(4, wav.byteLength - 8, true);
      dv.setUint32(8, 0x44415753, true); // WAVE
      dv.setUint32(12, 0x20746d66, true); // fmt
      dv.setUint32(16, 16, true);
      dv.setUint16(20, 1, true); // PCM
      dv.setUint16(22, 1, true); // mono
      dv.setUint32(24, rate, true);
      dv.setUint32(28, rate * 2, true);
      dv.setUint16(32, 2, true);
      dv.setUint16(34, 16, true);
      dv.setUint32(36, 0x64617461, true); // data
      dv.setUint32(40, pcm.byteLength, true);
      wav.set(pcm, 44);
      const out = await createVolcengineFlashProvider(resolved.auth).transcribe(
        { bytes: wav, fileName: "test.wav", format: "wav", duration: seconds },
        fetch,
      );
      return out.segments.length > 0
        ? { ok: true, modelsFound: null, message: "连接成功，鉴权与端点可达（样本返回了字幕，不代表整段能转写）" }
        : { ok: true, modelsFound: null, message: "连接成功，鉴权与端点可达（样本为静音）" };
    }
    // 标准版：官方示例 URL 提交一次；提交成功（X-Api-Status-Code 20000000）即视为鉴权可达，不轮询（ADR-0016 §9）
    const authHeaders: Record<string, string> = resolved.auth.kind === "apiKey"
      ? { "X-Api-Key": resolved.auth.apiKey }
      : { "X-Api-App-Key": resolved.auth.appKey, "X-Api-Access-Key": resolved.auth.accessKey };
    const body = JSON.stringify({
      user: { uid: resolved.auth.kind === "appAccessKey" ? resolved.auth.appKey : "video-notes" },
      audio: { url: "https://lf3-static.bytednsdoc.com/obj/eden-cn/lm_hz_ihsph/ljhwZthlaukjlkulzlp/console/bigtts/zh_female_cancan_mars_bigtts.mp3" },
      request: { model_name: "bigmodel", show_utterances: true, enable_itn: true, enable_punc: true, enable_speaker_info: false },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(VOLCENGINE_STANDARD_SUBMIT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Resource-Id": VOLCENGINE_STANDARD_RESOURCE_ID,
          "X-Api-Request-Id": randomUUID(),
          "X-Api-Sequence": "-1",
          ...authHeaders,
        },
        body,
        signal: controller.signal,
      });
      const statusCode = res.headers.get("x-api-status-code");
      if (res.ok && statusCode === "20000000") {
        return { ok: true, modelsFound: null, message: "连接成功，鉴权与端点可达（示例 URL 提交成功，未等待转写完成）" };
      }
      if (res.ok && statusCode === "45000002") {
        return { ok: false, modelsFound: null, message: "音频样本被判定为空" };
      }
      return { ok: false, modelsFound: null, message: `提交失败：HTTP ${res.status}${statusCode !== null ? `，X-Api-Status-Code ${statusCode}` : ""}` };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // 45000002（空音频）由火山极速版按业务错误报出，单独给可读文案而不是鉴权失败
    const message = sanitizeError(err);
    if (message.includes("45000002")) return { ok: false, modelsFound: null, message: "音频样本被判定为空" };
    return { ok: false, modelsFound: null, message };
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
  if (effectiveAsrProvider() !== "local") return;
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

/**
 * 启动时的模型校验（r26）：校验缓存只在进程内，重启后曾下载好的模型会回到「未校验」，
 * 而提取要求 ready。文件齐、字节数对的所有包在这里后台校验一遍，免掉每次启动手点「校验模型」。
 * 缺文件或已判 invalid 的包不在这里处理，交给自动下载或设置页导入。
 */
let autoVerify: Promise<void> | undefined;
function maybeAutoVerifyModels(): void {
  if (modelsDownloader.busy()) return;
  const status = modelStatus(settings.modelDir);
  if (status.ready) return;
  if (!status.bundles.every((b) => b.state === "unverified")) return;
  let lock: ReturnType<typeof acquireModelLock>;
  try {
    lock = acquireModelLock(settings.modelDir);
  } catch (err) {
    // 另一个实例正在校验/下载同一模型目录：保持「未校验」，用户可在设置页手动校验；不能让它中断启动
    console.warn(sanitizeError(err));
    return;
  }
  const done = (async () => {
    try {
      await verifyModels(settings.modelDir);
    } catch (err) {
      console.warn(sanitizeError(err));
    } finally {
      lock.release();
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.modelEvent, { state: "done", bundleId: null, receivedBytes: 0, totalBytes: 0, percent: null, message: null });
    }
  })();
  autoVerify = done;
  void done.finally(() => {
    if (autoVerify === done) autoVerify = undefined;
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
  credentialTxError = replayCredentialTransaction({
    userData: app.getPath("userData"),
    settingsFile: SETTINGS_PATH(),
    codec: electronCodec,
    secretStore,
  });
  if (credentialTxError !== null) console.warn(sanitizeError(new Error(credentialTxError)));
  recomputeRuntimes();
  maybeAutoDownload();
  maybeAutoVerifyModels();

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

  ipcMain.handle(
    IPC.listLibrary,
    guard(() => listLibrary(settings.notesRoot, { busyVideoId: queue.active()?.videoId ?? null }).map(toVideoDto)),
  );
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
